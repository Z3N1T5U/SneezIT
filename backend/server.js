// ============================================================================
// PeerDrop Signaling Server
// ============================================================================
//
// This is the signaling server for PeerDrop — a P2P file-sharing app built
// with WebRTC. WebRTC lets two browsers talk directly, but they need a
// "matchmaker" to find each other first. That's what this server does.
//
// Think of it like a phone operator from the old days: two callers tell the
// operator who they want to reach, the operator connects the wires, and then
// the callers talk directly without the operator listening in.
//
// The server handles:
//   1. Room creation & joining  — so two peers can find each other
//   2. SDP & ICE relay          — the WebRTC "handshake" messages
//   3. WebSocket relay fallback — if P2P is blocked by firewalls
//   4. Chat message forwarding  — text chat between peers
//
// ============================================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// ============================================================================
// Server Configuration
// ============================================================================

const PORT = process.env.PORT || 5000;

const app = express();
const server = http.createServer(app);

// Configure Socket.IO with CORS so the Vite dev server (port 5173) can connect.
// In production you'd lock this down to your actual domain.
const io = new Server(server, {
  cors: {
    origin: '*',                           // Allow all origins in dev
    methods: ['GET', 'POST'],
  },
  // Increase max buffer size to support relay mode (file chunks can be large)
  maxHttpBufferSize: 5e6, // 5 MB
});

// Express middleware
app.use(cors());
app.use(express.json());

// ============================================================================
// Room Storage
// ============================================================================
//
// We use an in-memory Map to store active rooms. Each room looks like:
//   {
//     id: 'abc123',              — 6-char alphanumeric room code
//     peers: ['socketId1', ...], — array of socket IDs (max 2)
//     createdAt: Date            — for auto-cleanup
//   }
//
// In-memory storage is fine for a signaling server because:
//   - Rooms are short-lived (one file transfer session)
//   - If the server restarts, peers just create a new room
//   - No sensitive data is stored

const rooms = new Map();

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Generate a 6-character alphanumeric room ID.
 * Uses a simple approach — pick random chars from a charset.
 * We check for collisions (astronomically unlikely but good practice).
 */
function generateRoomId() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/1/O/0 to avoid confusion
  let id;
  do {
    id = '';
    for (let i = 0; i < 6; i++) {
      id += charset.charAt(Math.floor(Math.random() * charset.length));
    }
  } while (rooms.has(id)); // Regenerate on collision (almost never happens)
  return id;
}

/**
 * Log a message with a timestamp prefix for easier debugging.
 * Example output: [2024-01-15 14:30:00] Room created: ABC123
 */
function log(message) {
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
  console.log(`[${timestamp}] ${message}`);
}

/**
 * Find the room that a given socket is currently in.
 * Returns the room object or undefined.
 */
function findRoomBySocketId(socketId) {
  for (const [, room] of rooms) {
    if (room.peers.includes(socketId)) {
      return room;
    }
  }
  return undefined;
}

/**
 * Get the other peer's socket ID in a room.
 * In a 2-person room, this finds "the person who isn't me."
 */
function getOtherPeer(room, mySocketId) {
  return room.peers.find((id) => id !== mySocketId);
}

// ============================================================================
// Room Auto-Cleanup
// ============================================================================
//
// Rooms that sit idle for over 1 hour get automatically deleted.
// This prevents memory leaks from abandoned rooms (e.g., a user closes the
// tab without properly disconnecting).

const ROOM_TTL_MS = 60 * 60 * 1000; // 1 hour in milliseconds

setInterval(() => {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      // Notify any peers still connected that the room expired
      room.peers.forEach((peerId) => {
        const peerSocket = io.sockets.sockets.get(peerId);
        if (peerSocket) {
          peerSocket.emit('room-expired', { roomId: id });
        }
      });
      rooms.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    log(`Auto-cleanup: removed ${cleaned} expired room(s). Active rooms: ${rooms.size}`);
  }
}, 5 * 60 * 1000); // Run cleanup every 5 minutes

// ============================================================================
// REST API Endpoints
// ============================================================================

/**
 * Health check endpoint.
 * Useful for monitoring, load balancers, and deployment checks.
 * Returns the server status and current number of active rooms.
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    rooms: rooms.size,
    uptime: Math.floor(process.uptime()),
  });
});

// ============================================================================
// Socket.IO Connection Handler
// ============================================================================
//
// This is where all the real-time signaling logic lives.
// Every event follows the same pattern:
//   1. Receive an event from one peer
//   2. Validate the data
//   3. Forward it to the other peer in the room

io.on('connection', (socket) => {
  log(`Peer connected: ${socket.id}`);

  // --------------------------------------------------------------------------
  // Room Creation
  // --------------------------------------------------------------------------
  // The first peer creates a room and gets back a shareable room code.
  // They then share this code with the person they want to send files to.

  socket.on('create-room', () => {
    // Check if this socket is already in a room
    const existingRoom = findRoomBySocketId(socket.id);
    if (existingRoom) {
      socket.emit('error-message', { message: 'You are already in a room. Leave it first.' });
      return;
    }

    const roomId = generateRoomId();

    // Create the room and add this peer as the first participant
    const room = {
      id: roomId,
      peers: [socket.id],
      createdAt: Date.now(),
    };

    rooms.set(roomId, room);

    // Join the Socket.IO room (this lets us broadcast to room members later)
    socket.join(roomId);

    // Tell the creator their room is ready
    socket.emit('room-created', { roomId });

    log(`Room created: ${roomId} by ${socket.id}. Active rooms: ${rooms.size}`);
  });

  // --------------------------------------------------------------------------
  // Room Joining
  // --------------------------------------------------------------------------
  // The second peer joins using the room code shared by the first peer.
  // We validate that the room exists and isn't full before allowing entry.

  socket.on('join-room', ({ roomId }) => {
    // Normalize the room code (uppercase, trim whitespace)
    const normalizedId = roomId?.trim().toUpperCase();

    // Validate: does the room exist?
    const room = rooms.get(normalizedId);
    if (!room) {
      socket.emit('error-message', { message: 'Room not found. Check the code and try again.' });
      return;
    }

    // Validate: is the room full? (max 2 peers for P2P)
    if (room.peers.length >= 2) {
      socket.emit('error-message', { message: 'Room is full. Only 2 peers can connect.' });
      return;
    }

    // Validate: is this peer already in the room?
    if (room.peers.includes(socket.id)) {
      socket.emit('error-message', { message: 'You are already in this room.' });
      return;
    }

    // Add the joiner to the room
    room.peers.push(socket.id);
    socket.join(normalizedId);

    // Tell the joiner they successfully joined
    socket.emit('room-joined', {
      roomId: normalizedId,
      peerId: room.peers[0], // The ID of the other peer already in the room
    });

    // Tell the existing peer that someone joined — they should start the
    // WebRTC offer process now
    const otherPeerId = getOtherPeer(room, socket.id);
    if (otherPeerId) {
      io.to(otherPeerId).emit('peer-joined', {
        peerId: socket.id,
      });
    }

    log(`Peer ${socket.id} joined room ${normalizedId}. Peers in room: ${room.peers.length}`);
  });

  // --------------------------------------------------------------------------
  // WebRTC Signaling: SDP Offer
  // --------------------------------------------------------------------------
  // Step 1 of the WebRTC handshake. The "caller" creates an offer describing
  // what media/data it wants to send, and we forward it to the "callee."
  //
  // SDP (Session Description Protocol) contains info about:
  //   - Codecs supported
  //   - ICE candidates (network addresses)
  //   - Data channel configuration

  socket.on('offer', ({ offer, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('offer', { offer, from: socket.id });
      log(`SDP offer forwarded in room ${roomId}`);
    }
  });

  // --------------------------------------------------------------------------
  // WebRTC Signaling: SDP Answer
  // --------------------------------------------------------------------------
  // Step 2 of the WebRTC handshake. The callee responds with an answer
  // confirming which codecs/config they support. After this exchange,
  // both peers know how to communicate.

  socket.on('answer', ({ answer, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('answer', { answer, from: socket.id });
      log(`SDP answer forwarded in room ${roomId}`);
    }
  });

  // --------------------------------------------------------------------------
  // WebRTC Signaling: ICE Candidates
  // --------------------------------------------------------------------------
  // ICE (Interactive Connectivity Establishment) candidates are potential
  // network paths the peers can use to connect. Each peer discovers its own
  // candidates (local IP, public IP via STUN, relay via TURN) and sends
  // them to the other peer through this server.
  //
  // The peers try each candidate pair until they find one that works.
  // This is why WebRTC can traverse most NATs and firewalls.

  socket.on('ice-candidate', ({ candidate, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('ice-candidate', { candidate, from: socket.id });
      // Not logging every ICE candidate — there can be dozens per connection
    }
  });

  // --------------------------------------------------------------------------
  // Chat Messages
  // --------------------------------------------------------------------------
  // Forward text chat messages between peers. This works even before the
  // WebRTC DataChannel is established, since it goes through the server.
  // Also serves as a fallback if DataChannel fails.

  socket.on('chat-message', ({ message, roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('chat-message', {
        message,
        from: socket.id,
        timestamp: Date.now(),
      });
    }
  });

  // --------------------------------------------------------------------------
  // WebSocket Relay Fallback
  // --------------------------------------------------------------------------
  // Sometimes WebRTC just won't work — strict corporate firewalls, symmetric
  // NATs, no TURN server available, etc. In these cases, we fall back to
  // relaying the file data through this server via WebSocket.
  //
  // This is slower than P2P (all data routes through the server) but it
  // guarantees the transfer will work. It's the "it just works" backup plan.

  /**
   * relay-signal: Peers use this to coordinate switching to relay mode.
   * When one peer detects that P2P isn't going to work, it tells the other
   * peer "hey, let's use the server as a relay instead."
   */
  socket.on('relay-signal', ({ roomId, data }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('relay-signal', { data, from: socket.id });
      log(`Relay signal forwarded in room ${roomId}`);
    }
  });

  /**
   * relay-meta: Forward file metadata when using relay mode.
   * Before sending actual file data, the sender tells the receiver about
   * the file: name, size, MIME type, and how many chunks to expect.
   */
  socket.on('relay-meta', ({ roomId, metadata }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('relay-meta', { metadata, from: socket.id });
      log(`Relay metadata forwarded in room ${roomId}: ${metadata?.name} (${metadata?.size} bytes)`);
    }
  });

  /**
   * relay-data: Forward a chunk of file data from sender to receiver.
   * Files are split into chunks on the sender side, sent through the server,
   * and reassembled on the receiver side. Each chunk includes an index so
   * the receiver can put them back in order.
   */
  socket.on('relay-data', ({ roomId, chunk, index, totalChunks }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const otherPeer = getOtherPeer(room, socket.id);
    if (otherPeer) {
      io.to(otherPeer).emit('relay-data', {
        chunk,
        index,
        totalChunks,
        from: socket.id,
      });
      // Log progress every 10% to avoid flooding the console
      if (totalChunks && index % Math.max(1, Math.floor(totalChunks / 10)) === 0) {
        log(`Relay progress in room ${roomId}: chunk ${index + 1}/${totalChunks}`);
      }
    }
  });

  // --------------------------------------------------------------------------
  // Disconnect Handling
  // --------------------------------------------------------------------------
  // When a peer disconnects (closes tab, loses connection, etc.), we need to:
  //   1. Find what room they were in
  //   2. Notify the other peer so they can show "peer disconnected" in the UI
  //   3. Clean up the room if it's now empty

  socket.on('disconnect', (reason) => {
    log(`Peer disconnected: ${socket.id} (reason: ${reason})`);

    const room = findRoomBySocketId(socket.id);
    if (!room) return;

    // Remove the disconnected peer from the room
    room.peers = room.peers.filter((id) => id !== socket.id);

    // Notify the remaining peer (if any) that their partner left
    const remainingPeer = room.peers[0];
    if (remainingPeer) {
      io.to(remainingPeer).emit('peer-disconnected', {
        peerId: socket.id,
      });
      log(`Notified ${remainingPeer} that peer left room ${room.id}`);
    }

    // If the room is now empty, delete it immediately
    if (room.peers.length === 0) {
      rooms.delete(room.id);
      log(`Room ${room.id} deleted (empty). Active rooms: ${rooms.size}`);
    }
  });
});

// ============================================================================
// Start the Server
// ============================================================================

server.listen(PORT, () => {
  log('='.repeat(50));
  log(`PeerDrop Signaling Server is running!`);
  log(`HTTP:      http://localhost:${PORT}`);
  log(`Health:    http://localhost:${PORT}/health`);
  log(`WebSocket: ws://localhost:${PORT}`);
  log('='.repeat(50));
});
