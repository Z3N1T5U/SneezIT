# SneezIT — Files "achoo" across browsers

A decentralized, browser-based peer-to-peer file sharing application built with **WebRTC** and **Socket.io**.

Share files directly between browsers — no cloud storage, no file size limits imposed by servers, no middleman. Your files never touch a server.

## Architecture

```
┌─────────────┐        Signaling         ┌─────────────┐
│   Sender    │◄──────(Socket.io)──────►│  Receiver   │
│  (Browser)  │                          │  (Browser)  │
│             │◄═══════════════════════►│             │
│             │    Direct P2P Transfer   │             │
│             │      (WebRTC Data)       │             │
└─────────────┘                          └─────────────┘
                        │
                  ┌─────┴─────┐
                  │ Signaling │
                  │  Server   │
                  │ (Node.js) │
                  └───────────┘
```

## Features

- 🔒 **End-to-End Encrypted** — Files transfer directly between peers via WebRTC
- 📦 **Chunked Transfer** — Large files are split into chunks for reliable delivery
- ✅ **SHA-256 Verification** — Every chunk is hash-verified for integrity
- 💬 **In-App Chat** — Text chat between peers over the data channel
- 📱 **Responsive** — Works on desktop and mobile
- 🔄 **WebSocket Relay Fallback** — Falls back to server relay when P2P is blocked by firewalls
- 📊 **Real-Time Stats** — Transfer speed, progress, and connection quality indicators

## Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Frontend   | React + Vite + Tailwind CSS       |
| Backend    | Node.js + Express + Socket.io     |
| P2P        | WebRTC RTCPeerConnection + DataChannel |
| Hashing    | Web Crypto API (SHA-256)          |

## Getting Started

### Prerequisites
- Node.js >= 18
- npm >= 9

### Backend
```bash
cd backend
npm install
npm run dev
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173` in two browser windows (or one in incognito) to test P2P transfer.

## How It Works

1. **Sender** selects file(s) and creates a room
2. **Receiver** joins via shared link/Room ID
3. **Signaling server** brokers WebRTC Offer/Answer/ICE exchange
4. **Direct P2P connection** is established
5. File chunks are sent over `RTCDataChannel` with SHA-256 verification
6. If P2P fails (firewall), **WebSocket relay** kicks in automatically

## Deployment

- **Frontend**: Deploy to [Vercel](https://vercel.com) — static build, no server needed
- **Backend**: Deploy to [Render](https://render.com) — supports persistent WebSocket connections

## License

MIT
