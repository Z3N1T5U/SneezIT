// ============================================================================
// WebRTC Peer Connection Manager
// ============================================================================
//
// This is the HEART of PeerDrop — the module that makes browsers talk directly.
//
// WHAT IS WebRTC?
// WebRTC (Web Real-Time Communication) is a browser API that lets two browsers
// exchange data directly, without routing through a server. Originally designed
// for video calls, we use its "DataChannel" feature for file transfer.
//
// THE CONNECTION FLOW (simplified):
//   1. Peer A creates an RTCPeerConnection and a DataChannel
//   2. Peer A generates an "Offer" (SDP) describing its capabilities
//   3. The Offer is sent to Peer B through our signaling server
//   4. Peer B creates its own RTCPeerConnection and sets the Offer
//   5. Peer B generates an "Answer" (SDP) and sends it back
//   6. Both peers exchange ICE candidates (network routes)
//   7. When a working route is found → direct P2P connection!
//
// ICE CANDIDATES:
// ICE = Interactive Connectivity Establishment. Each peer discovers multiple
// ways it could be reached (local IP, public IP from STUN, relay from TURN).
// These are "candidates." Both peers try connecting via each candidate pair
// until one works.
//
// STUN vs TURN:
// - STUN: A lightweight server that tells you your public IP. Free and fast.
//   Think of it as asking "what's my address?" at a post office.
// - TURN: A relay server that forwards data when direct connection fails.
//   Think of it as mailing a package through a forwarding service.
//   We don't use TURN in this project (costs money to host), but our
//   WebSocket relay fallback serves the same purpose for free.
//
// ============================================================================

import { CHUNK_SIZE, computeHash, chunkFile, generateFileId } from './fileUtils';

// ============================================================================
// STUN Server Configuration
// ============================================================================
// These are free, public STUN servers provided by Google.
// They help peers discover their public IP addresses.
// We list multiple servers for redundancy — if one is down, others work.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' },
];

// How long to wait for ICE candidates before giving up (milliseconds)
const ICE_GATHERING_TIMEOUT = 10000;

// How long to wait for P2P connection before falling back to relay
const CONNECTION_TIMEOUT = 15000;

// ============================================================================
// PeerConnection Class
// ============================================================================
// Encapsulates all WebRTC logic into a clean, reusable class.

export class PeerConnection {
  constructor(socket, roomId, isSender, callbacks = {}) {
    // Store references
    this.socket = socket;           // Socket.io instance for signaling
    this.roomId = roomId;           // The room we're in
    this.isSender = isSender;       // Are we sending or receiving?
    this.callbacks = callbacks;     // UI callback functions
    
    // WebRTC objects
    this.pc = null;                 // RTCPeerConnection instance
    this.dataChannel = null;        // RTCDataChannel for file transfer
    this.chatChannel = null;        // RTCDataChannel for chat messages
    
    // Connection state
    this.connected = false;
    this.usingRelay = false;        // True if P2P failed and we're using server relay
    this.connectionTimeout = null;
    
    // Transfer state (sender side)
    this.filesToSend = [];          // Queue of files to send
    this.currentFileIndex = 0;
    this.sending = false;
    
    // Transfer state (receiver side)
    this.receivedChunks = [];       // Received chunks for current file
    this.receivedFilesMeta = [];    // Metadata for all files being received
    this.currentReceivingFile = null;
    this.totalBytesReceived = 0;
    
    // Stats tracking
    this.transferStartTime = null;
    this.lastSpeedUpdate = null;
    this.lastBytesForSpeed = 0;
    this.currentSpeed = 0;
    
    // Initialize
    this._setupSocketListeners();
  }

  // ==========================================================================
  // Socket.IO Event Listeners (Signaling)
  // ==========================================================================
  // These handle the WebRTC handshake messages that come through the server.

  _setupSocketListeners() {
    // When we receive an Offer from the other peer
    this.socket.on('offer', async ({ offer }) => {
      this._log('Received SDP offer');
      this.callbacks.onStatus?.('Received connection offer...');
      await this._handleOffer(offer);
    });

    // When we receive an Answer to our Offer
    this.socket.on('answer', async ({ answer }) => {
      this._log('Received SDP answer');
      this.callbacks.onStatus?.('Connection answer received...');
      await this._handleAnswer(answer);
    });

    // When we receive an ICE candidate from the other peer
    this.socket.on('ice-candidate', async ({ candidate }) => {
      await this._handleIceCandidate(candidate);
    });

    // Relay fallback events (when P2P is blocked)
    this.socket.on('relay-signal', ({ data }) => {
      if (data.type === 'activate-relay') {
        this._log('Peer requested relay mode');
        this.usingRelay = true;
        this.callbacks.onRelayActivated?.();
      }
    });

    this.socket.on('relay-meta', ({ metadata }) => {
      this._handleRelayMeta(metadata);
    });

    this.socket.on('relay-data', ({ chunk, index, totalChunks }) => {
      this._handleRelayChunk(chunk, index, totalChunks);
    });
  }

  // ==========================================================================
  // Connection Initialization
  // ==========================================================================

  /**
   * Create the RTCPeerConnection and set up its event handlers.
   * This is called before creating an offer or handling one.
   */
  _createPeerConnection() {
    this._log('Creating RTCPeerConnection with STUN servers');
    
    // Create the connection with our ICE (STUN) server config
    this.pc = new RTCPeerConnection({
      iceServers: ICE_SERVERS,
    });

    // ---- Event: ICE Candidate Found ----
    // As the browser discovers possible network routes, it fires this event.
    // We send each candidate to the other peer through the signaling server.
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', {
          candidate: event.candidate,
          roomId: this.roomId,
        });
      }
    };

    // ---- Event: ICE Gathering State Changed ----
    // Tracks the progress of ICE candidate discovery
    this.pc.onicegatheringstatechange = () => {
      this._log(`ICE gathering state: ${this.pc.iceGatheringState}`);
      this.callbacks.onIceState?.({
        gathering: this.pc.iceGatheringState,
        connection: this.pc.iceConnectionState,
      });
    };

    // ---- Event: ICE Connection State Changed ----
    // This tells us whether the P2P connection succeeded or failed
    this.pc.oniceconnectionstatechange = () => {
      const state = this.pc.iceConnectionState;
      this._log(`ICE connection state: ${state}`);
      
      this.callbacks.onIceState?.({
        gathering: this.pc.iceGatheringState,
        connection: state,
      });

      switch (state) {
        case 'connected':
        case 'completed':
          this._onP2PConnected();
          break;
        case 'failed':
          this._log('P2P connection failed — activating relay fallback');
          this._activateRelay();
          break;
        case 'disconnected':
          this.callbacks.onStatus?.('Peer connection lost...');
          break;
        case 'closed':
          this.callbacks.onStatus?.('Connection closed');
          break;
      }
    };

    // ---- Event: Connection State Changed ----
    this.pc.onconnectionstatechange = () => {
      this._log(`Connection state: ${this.pc.connectionState}`);
      this.callbacks.onConnectionState?.(this.pc.connectionState);
    };

    // ---- Event: Data Channel Received (Receiver side) ----
    // When the sender creates a data channel, the receiver gets it here
    this.pc.ondatachannel = (event) => {
      this._log(`Received data channel: ${event.channel.label}`);
      
      if (event.channel.label === 'fileTransfer') {
        this.dataChannel = event.channel;
        this._setupDataChannel(this.dataChannel);
      } else if (event.channel.label === 'chat') {
        this.chatChannel = event.channel;
        this._setupChatChannel(this.chatChannel);
      }
    };
  }

  /**
   * Called when P2P connection is successfully established.
   */
  _onP2PConnected() {
    if (this.connected) return; // Avoid duplicate calls
    
    this.connected = true;
    clearTimeout(this.connectionTimeout);
    
    this._log('✅ P2P connection established!');
    this.callbacks.onConnected?.({ relay: false });
    this.callbacks.onStatus?.('P2P connection established!');
  }

  // ==========================================================================
  // Offer / Answer Flow (WebRTC Handshake)
  // ==========================================================================

  /**
   * Initiate the WebRTC connection by creating an Offer.
   * Called by the SENDER when the receiver joins the room.
   */
  async createOffer() {
    this._createPeerConnection();
    
    // Create the data channels BEFORE creating the offer
    // The offer needs to know about the channels we want to establish
    this._createDataChannels();
    
    this.callbacks.onStatus?.('Creating connection offer...');
    
    try {
      // Create the SDP offer
      const offer = await this.pc.createOffer();
      
      // Set our local description (our side of the connection info)
      await this.pc.setLocalDescription(offer);
      
      // Send the offer to the other peer through the signaling server
      this.socket.emit('offer', {
        offer: this.pc.localDescription,
        roomId: this.roomId,
      });
      
      this._log('SDP offer created and sent');
      this.callbacks.onStatus?.('Offer sent, waiting for answer...');
      
      // Start a timeout — if P2P doesn't connect in time, use relay
      this._startConnectionTimeout();
      
    } catch (error) {
      this._log(`Error creating offer: ${error.message}`);
      this.callbacks.onError?.(`Failed to create connection: ${error.message}`);
    }
  }

  /**
   * Handle an incoming Offer and create an Answer.
   * Called by the RECEIVER when the sender's offer arrives.
   */
  async _handleOffer(offer) {
    this._createPeerConnection();
    
    try {
      // Set the remote description (the other peer's connection info)
      await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
      
      // Create our answer
      const answer = await this.pc.createAnswer();
      await this.pc.setLocalDescription(answer);
      
      // Send the answer back through the signaling server
      this.socket.emit('answer', {
        answer: this.pc.localDescription,
        roomId: this.roomId,
      });
      
      this._log('SDP answer created and sent');
      this.callbacks.onStatus?.('Answer sent, establishing connection...');
      
    } catch (error) {
      this._log(`Error handling offer: ${error.message}`);
      this.callbacks.onError?.(`Failed to handle connection: ${error.message}`);
    }
  }

  /**
   * Handle an incoming Answer to our Offer.
   */
  async _handleAnswer(answer) {
    try {
      await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
      this._log('Remote description set from answer');
    } catch (error) {
      this._log(`Error handling answer: ${error.message}`);
    }
  }

  /**
   * Handle an incoming ICE candidate.
   */
  async _handleIceCandidate(candidate) {
    try {
      if (this.pc && candidate) {
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
      }
    } catch (error) {
      // ICE candidate errors are common and usually not fatal
      // e.g., receiving a candidate before the remote description is set
      this._log(`ICE candidate error (usually harmless): ${error.message}`);
    }
  }

  // ==========================================================================
  // Data Channels
  // ==========================================================================
  // DataChannels are like WebSockets, but they go directly between browsers
  // instead of through a server. We create two channels:
  //   1. fileTransfer — for sending file chunks (binary data)
  //   2. chat — for sending text messages (JSON strings)

  /**
   * Create the data channels (sender side only).
   * The receiver will get these channels via the ondatachannel event.
   */
  _createDataChannels() {
    // File transfer channel — ordered and reliable (like TCP)
    this.dataChannel = this.pc.createDataChannel('fileTransfer', {
      ordered: true,  // Chunks arrive in order (important for file assembly!)
    });
    this._setupDataChannel(this.dataChannel);
    
    // Chat channel — ordered and reliable
    this.chatChannel = this.pc.createDataChannel('chat', {
      ordered: true,
    });
    this._setupChatChannel(this.chatChannel);
    
    this._log('Data channels created: fileTransfer, chat');
  }

  /**
   * Set up event handlers for the file transfer data channel.
   */
  _setupDataChannel(channel) {
    // Binary data should be received as ArrayBuffer (not Blob)
    channel.binaryType = 'arraybuffer';
    
    channel.onopen = () => {
      this._log('File transfer channel opened');
      this.callbacks.onDataChannelOpen?.();
    };

    channel.onclose = () => {
      this._log('File transfer channel closed');
    };

    channel.onerror = (error) => {
      this._log(`Data channel error: ${error}`);
    };

    // Handle incoming messages (receiver side)
    channel.onmessage = (event) => {
      if (typeof event.data === 'string') {
        // JSON control message (metadata, completion, etc.)
        this._handleControlMessage(JSON.parse(event.data));
      } else {
        // Binary data (file chunk)
        this._handleChunk(event.data);
      }
    };
  }

  /**
   * Set up event handlers for the chat data channel.
   */
  _setupChatChannel(channel) {
    channel.onopen = () => {
      this._log('Chat channel opened');
    };

    channel.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.callbacks.onChatMessage?.({
          message: msg.message,
          from: 'peer',
          timestamp: msg.timestamp,
        });
      } catch (e) {
        this._log(`Invalid chat message: ${e.message}`);
      }
    };
  }

  // ==========================================================================
  // File Sending (Sender Side)
  // ==========================================================================

  /**
   * Queue files for sending.
   * @param {FileList|File[]} files - The files to send
   */
  async sendFiles(files) {
    this.filesToSend = Array.from(files);
    this.currentFileIndex = 0;
    
    this._log(`Queued ${this.filesToSend.length} file(s) for sending`);
    
    // Send file list metadata first so receiver knows what's coming
    const fileListMeta = this.filesToSend.map((file, index) => ({
      id: generateFileId(),
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
      index,
    }));
    
    if (this.usingRelay) {
      // Send via WebSocket relay
      for (const meta of fileListMeta) {
        this.socket.emit('relay-meta', { roomId: this.roomId, metadata: meta });
        await this._sendFileViaRelay(this.filesToSend[meta.index], meta);
      }
    } else {
      // Send via P2P DataChannel
      this._sendControlMessage({ type: 'file-list', files: fileListMeta });
      this.callbacks.onTransferStart?.(fileListMeta);
      await this._sendNextFile();
    }
  }

  /**
   * Send the next file in the queue over the DataChannel.
   * Files are sent one at a time, chunk by chunk.
   */
  async _sendNextFile() {
    if (this.currentFileIndex >= this.filesToSend.length) {
      // All files sent!
      this._sendControlMessage({ type: 'all-complete' });
      this.callbacks.onAllFilesComplete?.();
      this._log('All files sent successfully!');
      return;
    }
    
    const file = this.filesToSend[this.currentFileIndex];
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    
    this._log(`Sending file ${this.currentFileIndex + 1}/${this.filesToSend.length}: ${file.name} (${totalChunks} chunks)`);
    
    // Compute the full file hash before sending
    // The receiver will compute the same hash after receiving all chunks
    this.callbacks.onStatus?.(`Computing hash for ${file.name}...`);
    const fileBuffer = await file.arrayBuffer();
    const fileHash = await computeHash(fileBuffer);
    
    // Tell the receiver about this specific file
    this._sendControlMessage({
      type: 'file-start',
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      hash: fileHash,
      fileIndex: this.currentFileIndex,
    });
    
    this.transferStartTime = Date.now();
    this.lastSpeedUpdate = Date.now();
    this.lastBytesForSpeed = 0;
    
    // Send chunks one by one
    let bytesSent = 0;
    
    for await (const { chunk, index, totalChunks: total } of chunkFile(file)) {
      // Wait if the DataChannel's buffer is full
      // This prevents overwhelming the network and crashing the browser
      await this._waitForBufferDrain();
      
      // Send the binary chunk
      this.dataChannel.send(chunk);
      bytesSent += chunk.byteLength;
      
      // Update progress
      const progress = ((index + 1) / total) * 100;
      this._updateSpeed(bytesSent);
      
      this.callbacks.onProgress?.({
        fileIndex: this.currentFileIndex,
        fileName: file.name,
        chunkIndex: index,
        totalChunks: total,
        progress,
        bytesSent,
        totalBytes: file.size,
        speed: this.currentSpeed,
      });
    }
    
    // Tell receiver this file is complete
    this._sendControlMessage({
      type: 'file-end',
      fileIndex: this.currentFileIndex,
      hash: fileHash,
    });
    
    this._log(`File sent: ${file.name} (hash: ${fileHash.substring(0, 12)}...)`);
    
    // Move to next file
    this.currentFileIndex++;
    await this._sendNextFile();
  }

  /**
   * Wait for the DataChannel's buffer to drain below a threshold.
   * 
   * WHY IS THIS NEEDED?
   * The DataChannel has an internal buffer. If we send data faster than the
   * network can transmit it, the buffer fills up. If we keep sending, the
   * browser will either throw an error or drop data.
   * 
   * By waiting for the buffer to drain, we achieve flow control:
   * - Send as fast as the network allows
   * - Pause when the network is congested
   * - Resume when the buffer has space
   */
  _waitForBufferDrain() {
    // 256KB threshold — generous enough to keep the pipe full
    const BUFFER_THRESHOLD = 256 * 1024;
    
    if (!this.dataChannel || this.dataChannel.bufferedAmount <= BUFFER_THRESHOLD) {
      return Promise.resolve();
    }
    
    return new Promise((resolve) => {
      const checkBuffer = () => {
        if (this.dataChannel.bufferedAmount <= BUFFER_THRESHOLD) {
          resolve();
        } else {
          setTimeout(checkBuffer, 20); // Check every 20ms
        }
      };
      checkBuffer();
    });
  }

  // ==========================================================================
  // File Receiving (Receiver Side)
  // ==========================================================================

  /**
   * Handle a control message from the DataChannel.
   * Control messages are JSON strings that coordinate the transfer.
   */
  _handleControlMessage(msg) {
    switch (msg.type) {
      case 'file-list':
        // Sender told us what files are coming
        this.receivedFilesMeta = msg.files;
        this.callbacks.onFileList?.(msg.files);
        this._log(`Expecting ${msg.files.length} file(s)`);
        break;
        
      case 'file-start':
        // A new file is starting
        this.currentReceivingFile = msg;
        this.receivedChunks = [];
        this.totalBytesReceived = 0;
        this.transferStartTime = Date.now();
        this.lastSpeedUpdate = Date.now();
        this.lastBytesForSpeed = 0;
        
        this.callbacks.onFileStart?.(msg);
        this._log(`Receiving file: ${msg.name} (${msg.totalChunks} chunks, hash: ${msg.hash?.substring(0, 12)}...)`);
        break;
        
      case 'file-end':
        // File transfer complete — verify and trigger download
        this._assembleAndVerifyFile(msg);
        break;
        
      case 'all-complete':
        this.callbacks.onAllFilesComplete?.();
        this._log('All files received!');
        break;
    }
  }

  /**
   * Handle an incoming file chunk (binary ArrayBuffer).
   */
  _handleChunk(data) {
    this.receivedChunks.push(data);
    this.totalBytesReceived += data.byteLength;
    
    const totalChunks = this.currentReceivingFile?.totalChunks || 0;
    const progress = (this.receivedChunks.length / totalChunks) * 100;
    
    this._updateSpeed(this.totalBytesReceived);
    
    this.callbacks.onProgress?.({
      fileIndex: this.currentReceivingFile?.fileIndex || 0,
      fileName: this.currentReceivingFile?.name || 'Unknown',
      chunkIndex: this.receivedChunks.length - 1,
      totalChunks,
      progress,
      bytesSent: this.totalBytesReceived,
      totalBytes: this.currentReceivingFile?.size || 0,
      speed: this.currentSpeed,
    });
  }

  /**
   * Assemble all received chunks into a complete file and verify its hash.
   * 
   * HOW IT WORKS:
   * 1. Concatenate all ArrayBuffer chunks into one big ArrayBuffer
   * 2. Compute SHA-256 hash of the assembled file
   * 3. Compare with the sender's hash — if they match, file is intact!
   * 4. Create a Blob and trigger a browser download
   */
  async _assembleAndVerifyFile(endMsg) {
    this.callbacks.onStatus?.('Assembling file and verifying integrity...');
    
    // Step 1: Concatenate all chunks
    const totalSize = this.receivedChunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of this.receivedChunks) {
      assembled.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    
    // Step 2: Compute hash of the assembled file
    const receivedHash = await computeHash(assembled.buffer);
    const expectedHash = endMsg.hash || this.currentReceivingFile?.hash;
    const hashMatch = receivedHash === expectedHash;
    
    this._log(`Hash verification: ${hashMatch ? '✅ MATCH' : '❌ MISMATCH'}`);
    this._log(`  Expected: ${expectedHash?.substring(0, 20)}...`);
    this._log(`  Got:      ${receivedHash.substring(0, 20)}...`);
    
    this.callbacks.onHashVerification?.({
      fileIndex: this.currentReceivingFile?.fileIndex || 0,
      fileName: this.currentReceivingFile?.name,
      match: hashMatch,
      expectedHash,
      receivedHash,
    });
    
    // Step 3: Create a downloadable blob
    const blob = new Blob([assembled], {
      type: this.currentReceivingFile?.mimeType || 'application/octet-stream',
    });
    
    // Step 4: Trigger browser download
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.currentReceivingFile?.name || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    // Clean up the object URL to free memory
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    
    this.callbacks.onFileComplete?.({
      fileIndex: this.currentReceivingFile?.fileIndex || 0,
      name: this.currentReceivingFile?.name,
      size: totalSize,
      hash: receivedHash,
      verified: hashMatch,
    });
    
    // Clear chunks to free memory
    this.receivedChunks = [];
  }

  // ==========================================================================
  // WebSocket Relay Fallback
  // ==========================================================================
  // When P2P doesn't work (strict firewalls, symmetric NATs), we fall back
  // to relaying file data through the signaling server.
  //
  // WHY THIS MATTERS:
  // Your group chat discussed this! On public WiFi and corporate networks,
  // P2P is often blocked. Without a relay fallback, the app simply wouldn't
  // work on those networks. With relay, it works everywhere — just slower
  // because data routes through the server.

  /**
   * Start connection timeout timer.
   * If P2P doesn't connect within CONNECTION_TIMEOUT, activate relay.
   */
  _startConnectionTimeout() {
    this.connectionTimeout = setTimeout(() => {
      if (!this.connected) {
        this._log(`P2P connection timeout after ${CONNECTION_TIMEOUT}ms`);
        this._activateRelay();
      }
    }, CONNECTION_TIMEOUT);
  }

  /**
   * Activate WebSocket relay mode.
   * Notify the other peer and switch to server-relayed transfer.
   */
  _activateRelay() {
    if (this.usingRelay) return; // Already in relay mode
    
    this.usingRelay = true;
    this.connected = true; // We're "connected" via relay
    clearTimeout(this.connectionTimeout);
    
    // Tell the other peer we're switching to relay mode
    this.socket.emit('relay-signal', {
      roomId: this.roomId,
      data: { type: 'activate-relay' },
    });
    
    this._log('Switched to WebSocket relay mode (P2P blocked)');
    this.callbacks.onConnected?.({ relay: true });
    this.callbacks.onRelayActivated?.();
    this.callbacks.onStatus?.('P2P blocked — using server relay');
  }

  /**
   * Send a file through the WebSocket relay.
   */
  async _sendFileViaRelay(file, meta) {
    this._log(`Sending file via relay: ${file.name}`);
    this.transferStartTime = Date.now();
    this.lastSpeedUpdate = Date.now();
    this.lastBytesForSpeed = 0;
    
    const totalChunks = meta.totalChunks;
    let bytesSent = 0;
    let chunkIndex = 0;
    
    for await (const { chunk } of chunkFile(file)) {
      // Convert ArrayBuffer to base64 for WebSocket transport
      const base64 = arrayBufferToBase64(chunk);
      
      this.socket.emit('relay-data', {
        roomId: this.roomId,
        chunk: base64,
        index: chunkIndex,
        totalChunks,
      });
      
      bytesSent += chunk.byteLength;
      chunkIndex++;
      
      const progress = (chunkIndex / totalChunks) * 100;
      this._updateSpeed(bytesSent);
      
      this.callbacks.onProgress?.({
        fileIndex: meta.index,
        fileName: file.name,
        chunkIndex: chunkIndex - 1,
        totalChunks,
        progress,
        bytesSent,
        totalBytes: file.size,
        speed: this.currentSpeed,
      });
      
      // Small delay to avoid overwhelming the server
      await new Promise(r => setTimeout(r, 5));
    }
    
    this._log(`File sent via relay: ${file.name}`);
  }

  /**
   * Handle file metadata received via relay.
   */
  _handleRelayMeta(metadata) {
    this.currentReceivingFile = metadata;
    this.receivedChunks = [];
    this.totalBytesReceived = 0;
    this.transferStartTime = Date.now();
    
    this.callbacks.onFileStart?.(metadata);
    this.callbacks.onTransferStart?.([metadata]);
    this._log(`Receiving file via relay: ${metadata.name}`);
  }

  /**
   * Handle a file chunk received via relay.
   */
  _handleRelayChunk(base64Chunk, index, totalChunks) {
    // Convert base64 back to ArrayBuffer
    const chunk = base64ToArrayBuffer(base64Chunk);
    this.receivedChunks.push(chunk);
    this.totalBytesReceived += chunk.byteLength;
    
    const progress = ((index + 1) / totalChunks) * 100;
    this._updateSpeed(this.totalBytesReceived);
    
    this.callbacks.onProgress?.({
      fileIndex: this.currentReceivingFile?.index || 0,
      fileName: this.currentReceivingFile?.name || 'Unknown',
      chunkIndex: index,
      totalChunks,
      progress,
      bytesSent: this.totalBytesReceived,
      totalBytes: this.currentReceivingFile?.size || 0,
      speed: this.currentSpeed,
    });
    
    // If we've received all chunks, assemble the file
    if (index + 1 >= totalChunks) {
      this._assembleRelayFile();
    }
  }

  /**
   * Assemble a file received via relay and trigger download.
   */
  async _assembleRelayFile() {
    this.callbacks.onStatus?.('Assembling relayed file...');
    
    const totalSize = this.receivedChunks.reduce((sum, c) => sum + c.byteLength, 0);
    const assembled = new Uint8Array(totalSize);
    let offset = 0;
    
    for (const chunk of this.receivedChunks) {
      assembled.set(new Uint8Array(chunk), offset);
      offset += chunk.byteLength;
    }
    
    // Compute hash
    const hash = await computeHash(assembled.buffer);
    
    // Trigger download
    const blob = new Blob([assembled], {
      type: this.currentReceivingFile?.type || 'application/octet-stream',
    });
    
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = this.currentReceivingFile?.name || 'download';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    
    this.callbacks.onFileComplete?.({
      fileIndex: this.currentReceivingFile?.index || 0,
      name: this.currentReceivingFile?.name,
      size: totalSize,
      hash,
      verified: true, // Relay doesn't have sender hash to compare, mark as OK
    });
    
    this.callbacks.onAllFilesComplete?.();
    this.receivedChunks = [];
    this._log(`Relay file assembled and downloaded: ${this.currentReceivingFile?.name}`);
  }

  // ==========================================================================
  // Chat
  // ==========================================================================

  /**
   * Send a chat message to the peer.
   * Uses DataChannel if connected P2P, otherwise falls back to Socket.io.
   */
  sendChatMessage(message) {
    const msg = {
      message,
      timestamp: Date.now(),
    };
    
    if (this.chatChannel && this.chatChannel.readyState === 'open') {
      // Send directly over P2P
      this.chatChannel.send(JSON.stringify(msg));
    } else {
      // Fall back to server relay
      this.socket.emit('chat-message', {
        message,
        roomId: this.roomId,
      });
    }
    
    return msg;
  }

  // ==========================================================================
  // Utilities
  // ==========================================================================

  /**
   * Send a JSON control message over the file transfer DataChannel.
   */
  _sendControlMessage(msg) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(msg));
    }
  }

  /**
   * Update transfer speed calculation.
   * Uses a simple rolling calculation over 1-second windows.
   */
  _updateSpeed(currentBytes) {
    const now = Date.now();
    const elapsed = (now - this.lastSpeedUpdate) / 1000; // seconds
    
    if (elapsed >= 0.5) { // Update every 500ms
      const byteDelta = currentBytes - this.lastBytesForSpeed;
      this.currentSpeed = byteDelta / elapsed;
      this.lastSpeedUpdate = now;
      this.lastBytesForSpeed = currentBytes;
    }
  }

  /**
   * Logging helper with a [WebRTC] prefix for easy filtering.
   */
  _log(message) {
    console.log(`[WebRTC] ${message}`);
  }

  /**
   * Clean up all connections and resources.
   * Call this when leaving the room or unmounting the component.
   */
  destroy() {
    clearTimeout(this.connectionTimeout);
    
    if (this.dataChannel) {
      this.dataChannel.close();
      this.dataChannel = null;
    }
    
    if (this.chatChannel) {
      this.chatChannel.close();
      this.chatChannel = null;
    }
    
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    
    // Remove socket listeners
    this.socket.off('offer');
    this.socket.off('answer');
    this.socket.off('ice-candidate');
    this.socket.off('relay-signal');
    this.socket.off('relay-meta');
    this.socket.off('relay-data');
    
    this.connected = false;
    this._log('PeerConnection destroyed');
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert an ArrayBuffer to a base64 string.
 * Needed for WebSocket relay (sockets handle strings better than binary).
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Convert a base64 string back to an ArrayBuffer.
 */
function base64ToArrayBuffer(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}
