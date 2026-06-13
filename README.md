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

---

## Deployment

### Option A: Deploy Everything to Railway (Simplest)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
3. Select this repository
4. Set environment variables in Railway dashboard:
   - `JWT_SECRET` = a long random string
   - `ANNOUNCED_IP` = your Railway service's public IP (find it in Settings → Networking)
5. Railway auto-detects Node.js and runs `node server/index.js`

> **Note**: Railway free tier may not support UDP ports required by WebRTC. For production, use a VPS with ports 40000–40100 UDP open.

---

### Option B: Split Deployment (Vercel Frontend + Railway Backend)

Use this approach to get free static hosting on Vercel while running the backend on Railway.

#### 1. Deploy Backend to Railway

Follow the same Railway steps above. Note your Railway app URL, e.g.:
```
https://atombergfinal-production.up.railway.app
```

#### 2. Deploy Frontend to Vercel

1. Go to [vercel.com](https://vercel.com) → **New Project** → import this repo
2. **Configure build settings**:
   - **Framework Preset**: Other
   - **Root Directory**: `public`
   - **Build Command**: (leave empty — no build step needed)
   - **Output Directory**: `.` (serves the `public` folder directly)
3. Click **Deploy**

#### 3. Configure Frontend → Backend Connection

After deploying, update `public/config.js` with your Railway backend URL:

```js
window.APP_CONFIG = {
  BACKEND_URL: "https://atombergfinal-production.up.railway.app"
};
```

Commit and push — Vercel will auto-redeploy.

#### 4. Enable CORS on Railway

The backend already has CORS enabled for all origins (`cors: { origin: '*' }`) in both Express and Socket.io, so no additional configuration is needed.

#### Vercel Configuration

Create a `public/vercel.json` (if you want SPA-style routing or custom headers):

```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "X-Content-Type-Options", "value": "nosniff" },
        { "key": "X-Frame-Options", "value": "DENY" }
      ]
    }
  ]
}
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Frontend (Vercel or same server)                            │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │ agent    │  │ customer     │  │ admin        │           │
│  │ .html    │  │ .html        │  │ .html        │           │
│  └────┬─────┘  └──────┬───────┘  └──────┬───────┘           │
│       │               │                 │                    │
│       └───────────┬───┘─────────────────┘                    │
│                   │ Socket.io + REST (BACKEND_URL)           │
└───────────────────┼──────────────────────────────────────────┘
                    │
┌───────────────────┼──────────────────────────────────────────┐
│  Backend (Railway / VPS)                                     │
│  ┌────────────────┴──────────────────────────┐               │
│  │ Express + Socket.io + Mediasoup SFU       │               │
│  │ ┌───────────┐ ┌───────────┐ ┌───────────┐ │              │
│  │ │ REST API  │ │ Signaling │ │ SFU Media │ │              │
│  │ │ (JWT auth)│ │ (Socket)  │ │ (WebRTC)  │ │              │
│  │ └───────────┘ └───────────┘ └───────────┘ │              │
│  └───────────────────────────────────────────┘               │
│  SQLite DB │ Recordings Dir                                  │
└──────────────────────────────────────────────────────────────┘
```

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
- ✅ Cross-origin deployment support (Vercel frontend + Railway backend)
