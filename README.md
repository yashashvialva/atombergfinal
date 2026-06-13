# 🎥 VideoSupport — Real-Time Video Support Platform

A full-stack real-time video support platform built with **Node.js**, **Socket.io**, and **Mediasoup SFU**. Media routes through the server (not peer-to-peer), supporting agent/customer video calls, in-call chat, call recording, and an admin dashboard.

## Stack

- **Backend**: Node.js + Express + Socket.io
- **WebRTC SFU**: Mediasoup (media relayed through server)
- **Database**: SQLite (Node.js v22.5+ built-in `node:sqlite`)
- **Auth**: JWT
- **Frontend**: Vanilla HTML/CSS/JS (no build step)

## Pages

| Role | Path |
|---|---|
| Agent | `/agent.html` |
| Customer | `/customer.html?token=<invite_token>` |
| Admin | `/admin.html` |

## Local Development

```bash
npm install
node server/index.js
```

Open [http://localhost:3000/agent.html](http://localhost:3000/agent.html)  
Login: `admin` / `admin123`

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | (insecure default) | Secret for JWT signing — **change in production** |
| `SERVER_IP` | `127.0.0.1` | Local IP for mediasoup ICE |
| `ANNOUNCED_IP` | same as SERVER_IP | Public IP announced to WebRTC clients (set to your server's public IP in production) |

## Deploy to Railway

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select this repository
4. Set environment variables in Railway dashboard:
   - `JWT_SECRET` = a long random string
   - `ANNOUNCED_IP` = your Railway service's public IP (find it in Settings → Networking)
5. Railway auto-detects Node.js and runs `node server/index.js`

> **Note**: Railway free tier may not support UDP ports required by WebRTC. For production, use a VPS with ports 40000–40100 UDP open.

## Features

- ✅ Agent creates sessions → generates invite link for customer
- ✅ Customer joins via invite token (no login required)
- ✅ Real-time video/audio via Mediasoup SFU (server-relayed, not P2P)
- ✅ In-call text chat (persisted to SQLite)
- ✅ Mute audio / disable video controls
- ✅ Call recording via ffmpeg (optional — graceful fallback if not installed)
- ✅ Admin dashboard with live session monitoring
- ✅ Session history in SQLite database
- ✅ JWT-protected agent API
