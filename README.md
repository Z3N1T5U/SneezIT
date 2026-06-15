# SneezIT — Files "achoo" across browsers

A decentralized, browser-based peer-to-peer file sharing application built with WebRTC, Socket.io, and the Origin Private File System (OPFS).

Share files directly between browsers — no cloud storage, no file size limits imposed by servers, no middleman. Your files never touch a server.

## Live Demo

- **Frontend:** https://sneezit.vercel.app/
- **Backend:** https://sneezit.onrender.com

## Architecture

```text
Browser A (Sender)                   Browser B / C (Receivers)
┌─────────────────────┐              ┌─────────────────────┐
│  App.jsx            │              │  App.jsx            │
│  ┌───────────────┐  │   WebRTC     │  ┌───────────────┐  │
│  │  SwarmManager │◄─┼─DataChannel─►│  │  SwarmManager │  │
│  │  (webrtc.js)  │  │              │  │  (webrtc.js)  │  │
│  └───────┬───────┘  │              │  └───────┬───────┘  │
│          │          │              │          │          │
│  ┌───────▼───────┐  │              │  ┌───────▼───────┐  │
│  │  crypto.js    │  │              │  │  crypto.js    │  │
│  │  (AES-GCM)    │  │              │  │  (AES-GCM)    │  │
│  └───────┬───────┘  │              │  └───────┬───────┘  │
│          │  File    │              │          │  OPFS    │
│  ┌───────▼───────┐  │              │  ┌───────▼───────┐  │
│  │  File object  │  │              │  │  storage.js   │  │
│  │  (original)   │  │              │  │  (disk/RAM)   │  │
│  └───────────────┘  │              │  └───────────────┘  │
└────────────┬────────┘              └────────────┬────────┘
             │         Socket.IO                  │
             └──────────►server.js◄───────────────┘
                      (signaling only)
```

## Features

- **Mesh Swarming:** Multiple receivers share chunks with each other, BitTorrent style.
- **End-to-End Encrypted:** Files transfer directly between peers via WebRTC using AES-GCM 256-bit encryption. The server cannot read the files.
- **Auto-Resume:** Reconnect and continue downloading exactly where you left off.
- **OPFS Streaming:** Streams gigabyte-sized files directly to the disk without crashing the browser's RAM.
- **SHA-256 Verification:** Every completed file is hash-verified for integrity.
- **WebSocket Relay Fallback:** Falls back to server relay when P2P is blocked by strict firewalls.
- **Real-Time Stats:** Live transfer speed, progress, and active mesh peer count indicators.

## Tech Stack

| Layer      | Technology                        |
|------------|-----------------------------------|
| Frontend   | React + Vite + Tailwind CSS       |
| Backend    | Node.js + Express + Socket.io     |
| P2P        | WebRTC RTCPeerConnection + DataChannel |
| Cryptography| Web Crypto API (AES-GCM, SHA-256) |
| Storage    | Origin Private File System (OPFS) |

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

Open `http://localhost:5173` in multiple browser windows to test the mesh swarming capabilities.

## How It Works

1. **Sender** selects file(s) and creates a room.
2. **Receiver** joins via the shared link (the AES decryption key is passed securely in the URL hash).
3. **Signaling server** brokers the WebRTC Offer/Answer/ICE exchange.
4. **Direct P2P connection** is established and the signaling server disconnects.
5. File chunks are encrypted, requested via a bitfield protocol, and sent over the `RTCDataChannel`.
6. Peers share missing chunks with each other to form a mesh swarm.
