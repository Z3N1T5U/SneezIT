// ============================================================================
// Socket.io Connection Manager
// ============================================================================
//
// This module manages the WebSocket connection to our signaling server.
// 
// WHY A SEPARATE MODULE?
// Separating the socket logic from the UI keeps our code clean and testable.
// The UI doesn't need to know HOW we connect to the server — just that we CAN.
//
// HOW IT WORKS:
// - In development, we connect to localhost:5000 (our local signaling server)
// - In production, we connect to the deployed server URL (set via env variable)
// - We use a singleton pattern — only one socket connection per browser tab
//
// ============================================================================

import { io } from 'socket.io-client';

// Determine the signaling server URL based on environment
// In development (npm run dev), Vite sets import.meta.env.DEV to true
// In production, we use the VITE_SERVER_URL environment variable
const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:5000';

// Create the socket instance but DON'T connect yet
// autoConnect: false means we control when the connection starts
// This prevents wasted connections when the user hasn't done anything yet
let socket = null;

/**
 * Get or create the socket connection.
 * Uses a singleton pattern — calling this multiple times returns the same socket.
 * 
 * WHY SINGLETON?
 * If every React component created its own socket, we'd have multiple
 * connections to the server, causing duplicate events and wasted resources.
 */
export function getSocket() {
  if (!socket) {
    socket = io(SERVER_URL, {
      autoConnect: false,
      // Reconnection settings — try to reconnect if the connection drops
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      // Transport config — start with WebSocket, fall back to polling if needed
      transports: ['websocket', 'polling'],
    });
  }
  return socket;
}

/**
 * Connect the socket to the signaling server.
 * Call this when the user creates or joins a room.
 */
export function connectSocket() {
  const s = getSocket();
  if (!s.connected) {
    s.connect();
  }
  return s;
}

/**
 * Disconnect the socket from the signaling server.
 * Call this when the user leaves a room or navigates away.
 */
export function disconnectSocket() {
  if (socket && socket.connected) {
    socket.disconnect();
  }
}

/**
 * Check if the socket is currently connected.
 */
export function isConnected() {
  return socket?.connected || false;
}

export default { getSocket, connectSocket, disconnectSocket, isConnected };
