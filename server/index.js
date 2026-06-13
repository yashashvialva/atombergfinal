'use strict';

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { DatabaseSync } = require('node:sqlite');   // Built-in Node.js v22.5+ (stable v24+)
const mediasoup = require('mediasoup');
const { spawn } = require('child_process');

// ─── Config ───────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT       || 3000;
const JWT_SECRET  = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';
// Railway sets RAILWAY_PUBLIC_DOMAIN; fall back to SERVER_IP for local dev
const SERVER_IP   = process.env.SERVER_IP  || '127.0.0.1';
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || SERVER_IP;
const RECORDINGS_DIR = path.join(__dirname, '..', 'recordings');
const DB_PATH     = path.join(__dirname, '..', 'database.sqlite');
const PUBLIC_DIR  = path.join(__dirname, '..', 'public');

if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// ─── Database (node:sqlite — no native compile required) ─────────────────────
const db = new DatabaseSync(DB_PATH);

db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    invite_token TEXT UNIQUE,
    created_at INTEGER,
    ended_at INTEGER,
    status TEXT DEFAULT 'active'
  );
  CREATE TABLE IF NOT EXISTS participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    role TEXT,
    display_name TEXT,
    joined_at INTEGER,
    left_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    sender_name TEXT,
    sender_role TEXT,
    content TEXT,
    sent_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS recordings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    status TEXT DEFAULT 'processing',
    file_path TEXT,
    started_at INTEGER,
    completed_at INTEGER
  );
`);

// ─── Bundle mediasoup-client for browser ──────────────────────────────────────
async function bundleMediasoupClient() {
  const outFile = path.join(PUBLIC_DIR, 'mediasoup-client.js');
  if (fs.existsSync(outFile)) {
    console.log('[bundle] mediasoup-client.js already exists, skipping build.');
    return;
  }
  try {
    const esbuild = require('esbuild');
    await esbuild.build({
      entryPoints: [path.join(__dirname, 'mediasoup-entry.js')],
      bundle: true,
      outfile: outFile,
      globalName: 'mediasoupClient',
      platform: 'browser',
      format: 'iife',
      minify: false,
    });
    console.log('[bundle] mediasoup-client.js built successfully.');
  } catch (err) {
    console.error('[bundle] Failed to build mediasoup-client:', err.message);
  }
}

// ─── Express + HTTP + Socket.io ───────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET','POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use('/recordings', express.static(RECORDINGS_DIR));

// Explicit route for homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ─── Auth Middleware ───────────────────────────────────────────────────────────
function requireAgent(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (payload.role !== 'agent') return res.status(403).json({ error: 'Forbidden' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Auth
app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'admin' && password === 'admin123') {
    const token = jwt.sign({ sub: 'admin', role: 'agent', name: 'Admin Agent' }, JWT_SECRET, { expiresIn: '8h' });
    return res.json({ token, role: 'agent', name: 'Admin Agent' });
  }
  res.status(401).json({ error: 'Invalid credentials' });
});

// Create session
app.post('/api/sessions', requireAgent, (req, res) => {
  const sessionId    = uuidv4();
  const inviteToken  = uuidv4();
  const now          = Date.now();
  db.prepare('INSERT INTO sessions (id, invite_token, created_at, status) VALUES (?, ?, ?, ?)').run(sessionId, inviteToken, now, 'active');
  res.json({
    sessionId,
    inviteToken,
    inviteUrl: `${req.protocol}://${req.get('host')}/customer.html?token=${inviteToken}`,
  });
});

// List sessions
app.get('/api/sessions', requireAgent, (req, res) => {
  const sessions = db.prepare('SELECT * FROM sessions ORDER BY created_at DESC LIMIT 50').all();
  res.json(sessions);
});

// Chat history
app.get('/api/sessions/:id/chat', (req, res) => {
  const msgs = db.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY sent_at ASC').all(req.params.id);
  res.json(msgs);
});

// Recording status
app.get('/api/sessions/:id/recording', (req, res) => {
  const rec = db.prepare('SELECT * FROM recordings WHERE session_id = ? ORDER BY started_at DESC LIMIT 1').get(req.params.id);
  if (!rec) return res.json({ status: 'none' });
  const downloadUrl = rec.status === 'ready' ? `/recordings/${path.basename(rec.file_path)}` : null;
  res.json({ ...rec, downloadUrl });
});

// Health check (used by Railway)
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Admin live
app.get('/api/admin/live', requireAgent, (req, res) => {
  const sessions = db.prepare("SELECT * FROM sessions WHERE status = 'active'").all();
  const result = sessions.map(s => {
    const participants = db.prepare('SELECT * FROM participants WHERE session_id = ? AND left_at IS NULL').all(s.id);
    const roomData = rooms.get(s.id);
    return {
      sessionId:        s.id,
      createdAt:        s.created_at,
      durationMs:       Date.now() - s.created_at,
      participantCount: participants.length,
      participants:     participants.map(p => ({ name: p.display_name, role: p.role })),
      hasRouter:        !!roomData,
    };
  });
  res.json(result);
});

// End session via REST
app.delete('/api/sessions/:id', requireAgent, (req, res) => {
  endSession(req.params.id);
  res.json({ ok: true });
});

// ─── Mediasoup ────────────────────────────────────────────────────────────────
let worker;
// rooms: Map<sessionId, { router, peers: Map<socketId, peer>, recording? }>
const rooms = new Map();

async function createWorker() {
  worker = await mediasoup.createWorker({
    logLevel:   'warn',
    rtcMinPort: 40000,
    rtcMaxPort: 40100,
  });
  worker.on('died', () => {
    console.error('[mediasoup] Worker died — restarting in 2s…');
    setTimeout(createWorker, 2000);
  });
  console.log(`[mediasoup] Worker created pid=${worker.pid}`);
}

const MEDIA_CODECS = [
  { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
  { kind: 'video', mimeType: 'video/VP8',  clockRate: 90000, parameters: {} },
];

async function getOrCreateRoom(sessionId) {
  if (rooms.has(sessionId)) return rooms.get(sessionId);
  const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });
  const room = { router, peers: new Map(), recording: null };
  rooms.set(sessionId, room);
  return room;
}

async function createWebRtcTransport(router) {
  return router.createWebRtcTransport({
    listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
    enableUdp:  true,
    enableTcp:  true,
    preferUdp:  true,
  });
}

// ─── Session helpers ───────────────────────────────────────────────────────────
function endSession(sessionId) {
  db.prepare("UPDATE sessions SET status='ended', ended_at=? WHERE id=?").run(Date.now(), sessionId);
  const room = rooms.get(sessionId);
  if (room) {
    try { room.router.close(); } catch {}
    rooms.delete(sessionId);
  }
  io.to(sessionId).emit('session-ended');
  const sockets = io.sockets.adapter.rooms.get(sessionId);
  if (sockets) {
    for (const sid of [...sockets]) {
      const s = io.sockets.sockets.get(sid);
      if (s) s.disconnect(true);
    }
  }
}

// ─── Socket.io Signaling ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentSessionId  = null;
  let currentRole       = null;
  let currentName       = null;
  let participantDbId   = null;
  const transports = new Map();
  const producers  = new Map();
  const consumers  = new Map();

  // ── join-session ──────────────────────────────────────────────────
  socket.on('join-session', async ({ sessionId, token, role, displayName }, cb) => {
    try {
      // Customers join via invite token; look up their session automatically
      let sessionRow;
      if (role === 'customer' && (!sessionId || sessionId === 'null' || sessionId === null)) {
        sessionRow = db.prepare('SELECT * FROM sessions WHERE invite_token = ?').get(token);
        if (sessionRow) sessionId = sessionRow.id;
      } else {
        sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
      }

      if (!sessionRow)                      return cb({ error: 'Session not found' });
      if (sessionRow.status !== 'active')   return cb({ error: 'Session has ended' });

      // Auth check
      if (role === 'agent') {
        if (!token) return cb({ error: 'Agent token required' });
        try { jwt.verify(token, JWT_SECRET); } catch { return cb({ error: 'Invalid agent token' }); }
      } else {
        if (sessionRow.invite_token !== token) return cb({ error: 'Invalid invite token' });
      }

      currentSessionId = sessionId;
      currentRole      = role;
      currentName      = displayName || (role === 'agent' ? 'Agent' : 'Customer');

      socket.join(sessionId);

      const ins     = db.prepare('INSERT INTO participants (session_id, role, display_name, joined_at) VALUES (?, ?, ?, ?)').run(sessionId, role, currentName, Date.now());
      participantDbId = Number(ins.lastInsertRowid);

      const room = await getOrCreateRoom(sessionId);
      const peer = { socketId: socket.id, role, name: currentName, producers: new Map(), consumers: new Map(), transports: new Map() };
      room.peers.set(socket.id, peer);

      // Gather existing producers for this new peer to consume
      const existingProducers = [];
      for (const [peerId, p] of room.peers) {
        if (peerId === socket.id) continue;
        for (const [producerId, producer] of p.producers) {
          existingProducers.push({ producerId, peerId, kind: producer.kind });
        }
      }

      cb({
        ok: true,
        sessionId,
        routerRtpCapabilities: room.router.rtpCapabilities,
        existingProducers,
        participants: [...room.peers.values()].map(p => ({ socketId: p.socketId, name: p.name, role: p.role })),
      });

      socket.to(sessionId).emit('peer-joined', { socketId: socket.id, name: currentName, role });
    } catch (err) {
      console.error('[join-session]', err);
      cb({ error: err.message });
    }
  });

  // ── get-rtp-capabilities ──────────────────────────────────────────
  socket.on('get-rtp-capabilities', (_, cb) => {
    const room = rooms.get(currentSessionId);
    if (!room) return cb({ error: 'Room not found' });
    cb({ routerRtpCapabilities: room.router.rtpCapabilities });
  });

  // ── create-transport ──────────────────────────────────────────────
  socket.on('create-transport', async ({ direction }, cb) => {
    try {
      const room = rooms.get(currentSessionId);
      if (!room) return cb({ error: 'Room not found' });
      const transport = await createWebRtcTransport(room.router);
      transports.set(transport.id, transport);
      room.peers.get(socket.id)?.transports.set(transport.id, transport);
      cb({ id: transport.id, iceParameters: transport.iceParameters, iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters });
    } catch (err) { cb({ error: err.message }); }
  });

  // ── connect-transport ─────────────────────────────────────────────
  socket.on('connect-transport', async ({ transportId, dtlsParameters }, cb) => {
    try {
      const t = transports.get(transportId);
      if (!t) return cb({ error: 'Transport not found' });
      await t.connect({ dtlsParameters });
      cb({ ok: true });
    } catch (err) { cb({ error: err.message }); }
  });

  // ── produce ───────────────────────────────────────────────────────
  socket.on('produce', async ({ transportId, kind, rtpParameters, appData }, cb) => {
    try {
      const t = transports.get(transportId);
      if (!t) return cb({ error: 'Transport not found' });
      const producer = await t.produce({ kind, rtpParameters, appData });
      producers.set(producer.id, producer);
      rooms.get(currentSessionId)?.peers.get(socket.id)?.producers.set(producer.id, producer);
      cb({ id: producer.id });
      socket.to(currentSessionId).emit('new-producer', { producerId: producer.id, peerId: socket.id, kind });
    } catch (err) { cb({ error: err.message }); }
  });

  // ── consume ───────────────────────────────────────────────────────
  socket.on('consume', async ({ producerId, rtpCapabilities, transportId }, cb) => {
    try {
      const room = rooms.get(currentSessionId);
      if (!room) return cb({ error: 'Room not found' });
      if (!room.router.canConsume({ producerId, rtpCapabilities })) return cb({ error: 'Cannot consume' });
      const t = transports.get(transportId);
      if (!t) return cb({ error: 'Transport not found' });
      const consumer = await t.consume({ producerId, rtpCapabilities, paused: true });
      consumers.set(consumer.id, consumer);
      rooms.get(currentSessionId)?.peers.get(socket.id)?.consumers.set(consumer.id, consumer);
      cb({ id: consumer.id, producerId, kind: consumer.kind, rtpParameters: consumer.rtpParameters });
    } catch (err) { cb({ error: err.message }); }
  });

  // ── resume-consumer ───────────────────────────────────────────────
  socket.on('resume-consumer', async ({ consumerId }, cb) => {
    try {
      const c = consumers.get(consumerId);
      if (!c) return cb?.({ error: 'Consumer not found' });
      await c.resume();
      cb?.({ ok: true });
    } catch (err) { cb?.({ error: err.message }); }
  });

  // ── chat:message ──────────────────────────────────────────────────
  socket.on('chat:message', ({ sessionId, content, senderName, senderRole }) => {
    const sentAt = Date.now();
    db.prepare('INSERT INTO messages (session_id, sender_name, sender_role, content, sent_at) VALUES (?, ?, ?, ?, ?)').run(sessionId, senderName, senderRole, content, sentAt);
    io.to(sessionId).emit('chat:message', { senderName, senderRole, content, sentAt });
  });

  // ── mute-audio ────────────────────────────────────────────────────
  socket.on('mute-audio', ({ sessionId, muted }) => {
    socket.to(sessionId).emit('peer-muted', { socketId: socket.id, muted });
  });

  // ── disable-video ─────────────────────────────────────────────────
  socket.on('disable-video', ({ sessionId, disabled }) => {
    socket.to(sessionId).emit('peer-video-disabled', { socketId: socket.id, disabled });
  });

  // ── end-session (agent only) ──────────────────────────────────────
  socket.on('end-session', ({ sessionId }, cb) => {
    if (currentRole !== 'agent') return cb?.({ error: 'Forbidden' });
    endSession(sessionId);
    cb?.({ ok: true });
  });

  // ── start-recording ───────────────────────────────────────────────
  socket.on('start-recording', async ({ sessionId }, cb) => {
    if (currentRole !== 'agent') return cb?.({ error: 'Forbidden' });
    const room = rooms.get(sessionId);
    if (!room)         return cb?.({ error: 'Room not found' });
    if (room.recording) return cb?.({ error: 'Already recording' });

    const filePath = path.join(RECORDINGS_DIR, `${sessionId}.mp4`);
    const recId    = Number(db.prepare('INSERT INTO recordings (session_id, status, file_path, started_at) VALUES (?, ?, ?, ?)').run(sessionId, 'recording', filePath, Date.now()).lastInsertRowid);

    // Find first audio/video producers
    let videoProducer = null, audioProducer = null;
    for (const [, peer] of room.peers) {
      for (const [, producer] of peer.producers) {
        if (producer.kind === 'video' && !videoProducer) videoProducer = producer;
        if (producer.kind === 'audio' && !audioProducer) audioProducer = producer;
      }
    }
    if (!videoProducer && !audioProducer) {
      db.prepare("UPDATE recordings SET status='failed' WHERE id=?").run(recId);
      return cb?.({ error: 'No media to record' });
    }

    // Try to spawn ffmpeg — graceful fallback if not installed
    let ffmpegProc = null;
    try {
      ffmpegProc = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
      await new Promise((res, rej) => { ffmpegProc.on('close', c => c === 0 ? res() : rej()); ffmpegProc.on('error', rej); });
    } catch {
      db.prepare("UPDATE recordings SET status='failed' WHERE id=?").run(recId);
      io.to(sessionId).emit('recording-status', { status: 'failed', error: 'ffmpeg not found in PATH' });
      return cb?.({ error: 'ffmpeg not installed. Please install ffmpeg and add it to your PATH.' });
    }

    // Create PlainTransport consumers for RTP piping to ffmpeg
    const plainTransports = [];
    const ffmpegArgs = ['-y'];

    async function pipeProducer(producer, localPort, rtcpPort, ffmpegInputArgs) {
      const pt = await room.router.createPlainTransport({ listenIp: { ip: '127.0.0.1' }, rtcpMux: false, comedia: false });
      await pt.connect({ ip: '127.0.0.1', port: localPort, rtcpPort });
      const consumer = await pt.consume({ producerId: producer.id, rtpCapabilities: room.router.rtpCapabilities, paused: false });
      plainTransports.push({ pt, consumer });
      ffmpegArgs.push(...ffmpegInputArgs);
      return pt;
    }

    try {
      if (videoProducer) await pipeProducer(videoProducer, 5004, 5005, ['-f','rtp','-i','rtp://127.0.0.1:5004']);
      if (audioProducer) await pipeProducer(audioProducer, 5006, 5007, ['-f','rtp','-i','rtp://127.0.0.1:5006']);
      if (videoProducer) ffmpegArgs.push('-map', '0:v', '-c:v', 'copy');
      if (audioProducer) ffmpegArgs.push('-map', videoProducer ? '1:a' : '0:a', '-c:a', 'aac');
      ffmpegArgs.push(filePath);

      ffmpegProc = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe','pipe','pipe'] });
      ffmpegProc.stderr.on('data', d => console.log('[ffmpeg]', d.toString().trim().split('\n')[0]));
      ffmpegProc.on('error', err => {
        console.warn('[recording] ffmpeg error:', err.message);
        db.prepare("UPDATE recordings SET status='failed' WHERE id=?").run(recId);
        socket.emit('recording-status', { status: 'failed', error: err.message });
      });

      room.recording = { process: ffmpegProc, filePath, recId, plainTransports };
      io.to(sessionId).emit('recording-status', { status: 'recording' });
      cb?.({ ok: true });
    } catch (err) {
      console.error('[recording]', err);
      db.prepare("UPDATE recordings SET status='failed' WHERE id=?").run(recId);
      cb?.({ error: err.message });
    }
  });

  // ── stop-recording ────────────────────────────────────────────────
  socket.on('stop-recording', ({ sessionId }, cb) => {
    if (currentRole !== 'agent') return cb?.({ error: 'Forbidden' });
    const room = rooms.get(sessionId);
    if (!room?.recording) return cb?.({ error: 'Not recording' });
    const { process: proc, filePath, recId, plainTransports: pts } = room.recording;
    try { if (proc && !proc.killed) proc.kill('SIGINT'); } catch {}
    for (const { pt, consumer } of pts || []) {
      try { consumer.close(); } catch {}
      try { pt.close(); } catch {}
    }
    room.recording = null;
    db.prepare("UPDATE recordings SET status='ready', completed_at=? WHERE id=?").run(Date.now(), recId);
    const downloadUrl = `/recordings/${path.basename(filePath)}`;
    io.to(sessionId).emit('recording-status', { status: 'ready', downloadUrl });
    cb?.({ ok: true, downloadUrl });
  });

  // ── leave-session ─────────────────────────────────────────────────
  socket.on('leave-session', ({ sessionId }) => handleLeave(sessionId));

  // ── disconnect ────────────────────────────────────────────────────
  socket.on('disconnect', () => { if (currentSessionId) handleLeave(currentSessionId); });

  function handleLeave(sessionId) {
    if (participantDbId) {
      db.prepare('UPDATE participants SET left_at=? WHERE id=?').run(Date.now(), participantDbId);
      participantDbId = null;
    }
    const room = rooms.get(sessionId);
    if (room) {
      const peer = room.peers.get(socket.id);
      if (peer) {
        for (const [, p] of peer.producers)  { try { p.close(); } catch {} }
        for (const [, c] of peer.consumers)  { try { c.close(); } catch {} }
        for (const [, t] of peer.transports) { try { t.close(); } catch {} }
        room.peers.delete(socket.id);
      }
    }
    socket.to(sessionId).emit('peer-left', { peerId: socket.id });
    socket.leave(sessionId);
    currentSessionId = null;
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
async function main() {
  // Write mediasoup-client entry point for esbuild
  const entryPath = path.join(__dirname, 'mediasoup-entry.js');
  if (!fs.existsSync(entryPath)) {
    fs.writeFileSync(entryPath, "const mc = require('mediasoup-client');\nwindow.mediasoupClient = mc;\n");
  }

  await createWorker();
  await bundleMediasoupClient();

  server.listen(PORT, () => {
    console.log(`\n🚀  Video Support Platform`);
    console.log(`    Agent:    http://localhost:${PORT}/agent.html`);
    console.log(`    Admin:    http://localhost:${PORT}/admin.html`);
    console.log(`    Customer: http://localhost:${PORT}/customer.html?token=<invite_token>\n`);
  });
}

main().catch(err => { console.error('Fatal startup error:', err); process.exit(1); });
