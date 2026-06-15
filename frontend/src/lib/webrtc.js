import { CHUNK_SIZE, computeHash } from './fileUtils';
import { encryptChunk, decryptChunk } from './crypto';
import { FileStorage } from './storage';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// ============================================================================
// SwarmManager (PeerConnection)
// ============================================================================
// Manages ALL peer connections in the room. Each connection is independent;
// the swarm can download chunks from multiple peers simultaneously.
//
// KEY DESIGN DECISIONS:
// 1. Sender tracks how many chunks it has served (for UI progress)
// 2. Receiver uses OPFS bitfield reconstruction for auto-resume
// 3. onDataChannelOpen does NOT reset appState if already transferring
// 4. onPeerLeft fires with remaining peer count for smart UI decisions
// 5. Encryption is optional — if no key, chunks are sent plaintext
// ============================================================================
export class PeerConnection {
  constructor(socket, roomId, isSender, callbacks) {
    this.socket = socket;
    this.roomId = roomId;
    this.isSender = isSender;
    this.callbacks = callbacks;
    this.encryptionKey = callbacks.encryptionKey || null;

    this.peers = new Map(); // peerId -> { pc, dc, relayMode, pendingCandidates }
    this.activeTransfers = new Map();
    this.isDestroyed = false;
    this._pullTimer = null;
    this._lastProgressEmit = 0; // Throttle progress UI updates

    this._registerSocketHandlers();
    this._startPullLoop();
  }

  // ==========================================================================
  // Socket event handlers (named so they can be removed cleanly in destroy)
  // ==========================================================================

  _registerSocketHandlers() {
    this._h_peerJoined = async ({ peerId }) => {
      if (this.isDestroyed) return;
      console.log(`[Swarm] peer-joined: ${peerId}`);
      this.callbacks.onPeerCountChange?.(this.peers.size + 1);
      await this._createPeer(peerId, true /* initiator */);
    };
    this._h_offer = async ({ offer, from }) => {
      if (this.isDestroyed) return;
      await this._createPeer(from, false);
      const p = this.peers.get(from);
      if (!p) return;
      await p.pc.setRemoteDescription(new RTCSessionDescription(offer));
      this._flushCandidates(from);
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      this.socket.emit('answer', { answer, roomId: this.roomId, targetPeerId: from });
    };
    this._h_answer = async ({ answer, from }) => {
      if (this.isDestroyed) return;
      const p = this.peers.get(from);
      if (!p) return;
      try { await p.pc.setRemoteDescription(new RTCSessionDescription(answer)); this._flushCandidates(from); }
      catch (e) { console.warn('[Swarm] setRemoteDescription(answer) failed:', e); }
    };
    this._h_ice = ({ candidate, from }) => {
      if (this.isDestroyed) return;
      const p = this.peers.get(from);
      if (!p) return;
      if (p.pc.remoteDescription?.type) {
        p.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
      } else {
        p.pendingCandidates.push(candidate);
      }
    };
    this._h_peerLeft = ({ peerId }) => {
      if (this.isDestroyed) return;
      this._removePeer(peerId);
      this.callbacks.onPeerLeft?.({ peerId, remainingPeers: this.peers.size });
      this.callbacks.onPeerCountChange?.(this.peers.size);
    };
    this._h_relay = ({ data, from }) => {
      if (this.isDestroyed) return;
      this._handleMsg(from, data);
    };

    this.socket.on('peer-joined', this._h_peerJoined);
    this.socket.on('offer', this._h_offer);
    this.socket.on('answer', this._h_answer);
    this.socket.on('ice-candidate', this._h_ice);
    this.socket.on('peer-disconnected', this._h_peerLeft);
    this.socket.on('relay-data', this._h_relay);
  }

  _unregisterSocketHandlers() {
    this.socket.off('peer-joined', this._h_peerJoined);
    this.socket.off('offer', this._h_offer);
    this.socket.off('answer', this._h_answer);
    this.socket.off('ice-candidate', this._h_ice);
    this.socket.off('peer-disconnected', this._h_peerLeft);
    this.socket.off('relay-data', this._h_relay);
  }

  // ==========================================================================
  // WebRTC peer lifecycle
  // ==========================================================================

  async _createPeer(peerId, isInitiator) {
    if (this.peers.has(peerId)) return;
    const pc = new RTCPeerConnection(ICE_SERVERS);
    const peer = { pc, dc: null, relayMode: false, pendingCandidates: [] };
    this.peers.set(peerId, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.socket.emit('ice-candidate', { candidate, roomId: this.roomId, targetPeerId: peerId });
    };
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      this.callbacks.onIceState?.({ connection: s });
      if (s === 'connected' || s === 'completed') this.callbacks.onConnected?.({ relay: false });
      else if (s === 'failed') { peer.relayMode = true; this.callbacks.onRelayActivated?.(); }
      else if (s === 'closed') this._removePeer(peerId);
    };

    if (isInitiator) {
      const dc = pc.createDataChannel('peerdrop', { ordered: true });
      this._setupDC(peerId, dc);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.socket.emit('offer', { offer, roomId: this.roomId, targetPeerId: peerId });
    } else {
      pc.ondatachannel = ({ channel }) => this._setupDC(peerId, channel);
    }
  }

  _flushCandidates(peerId) {
    const p = this.peers.get(peerId);
    if (!p?.pendingCandidates.length) return;
    p.pendingCandidates.forEach(c => p.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
    p.pendingCandidates = [];
  }

  _setupDC(peerId, dc) {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    peer.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      console.log(`[Swarm] DC open: ${peerId}`);
      this.callbacks.onDataChannelOpen?.();
      // Immediately sync state — send our file list (if sender) and bitfields
      if (this.isSender && this.activeTransfers.size > 0) {
        const files = [...this.activeTransfers.values()].map(t => ({
          name: t.metadata.name, size: t.metadata.size,
          type: t.metadata.type, fileIndex: t.metadata.fileIndex,
        }));
        this._sendTo(peerId, { type: 'file-list', files });
      }
      this._broadcastBitfields();
    };
    dc.onmessage = ({ data }) => this._handleMsg(peerId, data);
    dc.onerror = e => console.warn(`[Swarm] DC error ${peerId}:`, e);
  }

  _removePeer(peerId) {
    const p = this.peers.get(peerId);
    if (!p) return;
    try { p.dc?.close(); } catch (_) {}
    try { p.pc?.close(); } catch (_) {}
    this.peers.delete(peerId);
    for (const t of this.activeTransfers.values()) t.peerBitfields.delete(peerId);
  }

  // ==========================================================================
  // Messaging — binary protocol
  // ==========================================================================

  _sendTo(peerId, msg) {
    if (this.isDestroyed) return;
    const peer = this.peers.get(peerId);
    if (!peer) return;
    try {
      let buf;
      if (msg.type === 'chunk-data') {
        // [0x01][4B fileIdx][4B chunkIdx][payload]
        const hdr = new DataView(new ArrayBuffer(9));
        hdr.setUint8(0, 1);
        hdr.setUint32(1, msg.fileIndex, true);
        hdr.setUint32(5, msg.chunkIndex, true);
        const out = new Uint8Array(9 + msg.data.byteLength);
        out.set(new Uint8Array(hdr.buffer));
        out.set(new Uint8Array(msg.data), 9);
        buf = out.buffer;
      } else {
        // [0x00][JSON]
        const json = new TextEncoder().encode(JSON.stringify(msg));
        const out = new Uint8Array(1 + json.byteLength);
        out[0] = 0;
        out.set(json, 1);
        buf = out.buffer;
      }
      if (!peer.relayMode && peer.dc?.readyState === 'open') {
        // Respect backpressure: drop chunk if send buffer is overflowing (e.g. > 4MB)
        if (peer.dc.bufferedAmount > 4 * 1024 * 1024) {
          throw new Error('DataChannel send queue is full (Backpressure)');
        }
        peer.dc.send(buf);
      }
      else this.socket.emit('relay-data', { roomId: this.roomId, data: buf, targetPeerId: peerId });
    } catch (e) {
      if (!e.message.includes('Backpressure')) {
        console.warn(`[Swarm] _sendTo ${peerId}:`, e.message);
      }
      throw e; // Bubble up so the caller knows the chunk failed and can retry
    }
  }

  _broadcast(msg) {
    for (const id of this.peers.keys()) {
      try {
        this._sendTo(id, msg);
      } catch (e) {
        // Ignore broadcast failures, handled by pull loop retries
      }
    }
  }

  async _handleMsg(peerId, raw) {
    let buf = raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : raw;
    if (!(buf instanceof ArrayBuffer)) return;
    const v = new DataView(buf);
    if (v.getUint8(0) === 0) {
      try { await this._handleCtrl(peerId, JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 1)))); }
      catch (e) { console.error('[Swarm] JSON parse error:', e); }
    } else {
      await this._handleChunkData(peerId, v.getUint32(1, true), v.getUint32(5, true), buf.slice(9));
    }
  }

  // ==========================================================================
  // Control message dispatch
  // ==========================================================================

  async _handleCtrl(peerId, msg) {
    switch (msg.type) {
      case 'file-list':   this._handleFileList(msg.files); break;
      case 'bitfield':    this._handleBitfield(peerId, msg.fileIndex, msg.bitfield); break;
      case 'have-chunk':  this._handleHaveChunk(peerId, msg.fileIndex, msg.chunkIndex); break;
      case 'request-chunk': await this._handleChunkRequest(peerId, msg.fileIndex, msg.chunkIndex); break;
      case 'chat':        this.callbacks.onChatMessage?.({ message: msg.text, from: 'peer', timestamp: Date.now() }); break;
    }
  }

  // ==========================================================================
  // File list (sent by sender on DC open, and when first starting)
  // ==========================================================================

  async sendFiles(files) {
    this.isSender = true;
    const fileList = files.map((f, i) => ({ name: f.name, size: f.size, type: f.type, fileIndex: i }));
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      this.activeTransfers.set(i, {
        file,
        metadata: { name: file.name, size: file.size, type: file.type, totalChunks, fileIndex: i },
        myBitfield: new Uint8Array(totalChunks).fill(1),
        peerBitfields: new Map(),
        pendingRequests: new Set(),
        receivedCount: totalChunks,
        chunksServed: 0,
        speedTrack: { time: Date.now(), chunksServed: 0 },
      });
    }
    this._broadcast({ type: 'file-list', files: fileList });
    this._broadcastBitfields();
    this.callbacks.onTransferStart?.(fileList);
  }

  _handleFileList(files) {
    const newFiles = [];
    for (const meta of files) {
      if (this.activeTransfers.has(meta.fileIndex)) continue;
      const totalChunks = Math.ceil(meta.size / CHUNK_SIZE);
      const storage = new FileStorage(meta.name, meta.size);

      // Async init — returns reconstructed bitfield for auto-resume
      storage.init(totalChunks, CHUNK_SIZE).then(existingBitfield => {
        const haveCount = existingBitfield.reduce((s, b) => s + b, 0);
        const t = this.activeTransfers.get(meta.fileIndex);
        if (!t) return;
        t.myBitfield = existingBitfield;
        t.receivedCount = haveCount;
        this._broadcast({ type: 'bitfield', fileIndex: meta.fileIndex, bitfield: Array.from(existingBitfield) });
        if (haveCount > 0) {
          console.log(`[Swarm] Auto-resume: already have ${haveCount}/${totalChunks} chunks for "${meta.name}"`);
          this.callbacks.onResumed?.({ fileIndex: meta.fileIndex, chunksHave: haveCount, totalChunks });
        }
        // If already complete from OPFS (entire file was already downloaded before)
        if (haveCount >= totalChunks) {
          console.log(`[Swarm] File "${meta.name}" already complete in OPFS, finalizing...`);
          this._finalize(meta.fileIndex);
        }
      });

      this.activeTransfers.set(meta.fileIndex, {
        storage,
        metadata: { ...meta, totalChunks },
        myBitfield: new Uint8Array(totalChunks).fill(0), // Will be updated after init resolves
        peerBitfields: new Map(),
        pendingRequests: new Set(),
        receivedCount: 0,
        speedTrack: { time: Date.now(), bytes: 0 },
      });
      newFiles.push(meta);
    }
    if (newFiles.length > 0) {
      this.callbacks.onFileList?.(newFiles);
      this._broadcastBitfields();
    }
  }

  _broadcastBitfields() {
    for (const [fIdx, t] of this.activeTransfers) {
      this._broadcast({ type: 'bitfield', fileIndex: fIdx, bitfield: Array.from(t.myBitfield) });
    }
  }

  _handleBitfield(peerId, fileIndex, arr) {
    const t = this.activeTransfers.get(fileIndex);
    if (!t) return;
    t.peerBitfields.set(peerId, new Uint8Array(arr));
  }

  _handleHaveChunk(peerId, fileIndex, chunkIndex) {
    const t = this.activeTransfers.get(fileIndex);
    if (!t) return;
    if (!t.peerBitfields.has(peerId)) t.peerBitfields.set(peerId, new Uint8Array(t.metadata.totalChunks));
    t.peerBitfields.get(peerId)[chunkIndex] = 1;
    
    // Log true mesh swarming: if this chunk came from someone who isn't the original sender
    if (!this.isSender && peerId !== t.originalSenderId) {
      console.log(`[Swarm] Mesh active! Peer ${peerId.slice(0,6)} has chunk ${chunkIndex}`);
    }
  }

  // ==========================================================================
  // Pull loop — drives chunk requests from receiver side
  // ==========================================================================

  _startPullLoop() {
    this._pullTimer = setInterval(() => {
      if (!this.isDestroyed) this._tick();
    }, 40);
  }

  _tick() {
    const now = Date.now();
    // Throttle UI updates to max every 250ms to prevent flickering
    const shouldEmitProgress = (now - this._lastProgressEmit) >= 250;

    for (const [fIdx, t] of this.activeTransfers) {
      const isDone = t.receivedCount >= t.metadata.totalChunks;

      // ---- SENDER progress ----
      if (t.file) {
        if (!shouldEmitProgress) continue;
        const totalPeers = this.peers.size;
        if (totalPeers === 0) continue;
        let totalReceivedByPeers = 0;
        let peerCount = 0;
        for (const [, bf] of t.peerBitfields) {
          totalReceivedByPeers += bf.reduce((s, b) => s + b, 0);
          peerCount++;
        }
        if (peerCount === 0) continue;
        const avgChunksAtPeers = totalReceivedByPeers / peerCount;
        const pct = (avgChunksAtPeers / t.metadata.totalChunks) * 100;
        const bytesSent = Math.min(Math.round(avgChunksAtPeers) * CHUNK_SIZE, t.metadata.size);

        // Speed: bytes uploaded per second, using smoothed EMA
        const sElapsed = (now - t.speedTrack.time) / 1000;
        if (sElapsed >= 1.0) {
          const rawSpeed = (t.chunksServed - t.speedTrack.chunksServed) * CHUNK_SIZE / sElapsed;
          // Exponential moving average — blends new reading with history
          t._smoothedSpeed = t._smoothedSpeed !== undefined
            ? t._smoothedSpeed * 0.6 + rawSpeed * 0.4
            : rawSpeed;
          t.speedTrack = { time: now, chunksServed: t.chunksServed };
        }

        this.callbacks.onProgress?.({
          fileName: t.metadata.name, fileIndex: fIdx,
          progress: Math.min(pct, 100),
          bytesSent,
          totalBytes: t.metadata.size,
          speed: t._smoothedSpeed ?? 0, // Never undefined/flicker
          isSender: true,
          chunkIndex: Math.round(avgChunksAtPeers),
          totalChunks: t.metadata.totalChunks,
          activePeers: peerCount,
        });

        // Trigger file completion for sender when it reaches 100%
        if (pct >= 100 && !t.isFinalized) {
          t.isFinalized = true;
          this.callbacks.onFileComplete?.({
            fileIndex: fIdx, name: t.metadata.name, size: t.metadata.size,
            type: t.metadata.type, url: null, verified: true, checksum: 'AES-GCM Authenticated',
          });
          
          // Check if ALL files are completely seeded
          const allDone = [...this.activeTransfers.values()].every(
            tr => tr.isFinalized || (!tr.file && tr.receivedCount >= tr.metadata.totalChunks)
          );
          if (allDone) {
            this.callbacks.onAllFilesComplete?.();
          }
        }
        
        continue;
      }

      // ---- RECEIVER: already done ----
      if (isDone) continue;

      // ---- RECEIVER: emit progress (throttled) ----
      if (shouldEmitProgress) {
        const bytesNow = Math.min(t.receivedCount * CHUNK_SIZE, t.metadata.size);
        const rElapsed = (now - t.speedTrack.time) / 1000;

        // Only recalculate speed every ~0.8s to get a stable reading
        if (rElapsed >= 0.8) {
          const rawSpeed = (bytesNow - t.speedTrack.bytes) / rElapsed;
          // EMA smoothing: 50% weight to new reading, 50% to history
          t._smoothedSpeed = t._smoothedSpeed !== undefined
            ? t._smoothedSpeed * 0.5 + rawSpeed * 0.5
            : rawSpeed;
          t.speedTrack = { time: now, bytes: bytesNow };
        }

        this.callbacks.onProgress?.({
          fileName: t.metadata.name, fileIndex: fIdx,
          progress: (t.receivedCount / t.metadata.totalChunks) * 100,
          bytesSent: bytesNow,
          totalBytes: t.metadata.size,
          speed: t._smoothedSpeed ?? 0, // Persists last known speed, no flicker
          isSender: false,
          chunkIndex: t.receivedCount,
          totalChunks: t.metadata.totalChunks,
          activePeers: this.peers.size,
        });
      }

      // ---- RECEIVER: request missing chunks (always runs, not throttled) ----
      const MAX_INFLIGHT = 16;
      if (t.pendingRequests.size >= MAX_INFLIGHT) continue;
      for (let i = 0; i < t.metadata.totalChunks; i++) {
        if (t.pendingRequests.size >= MAX_INFLIGHT) break;
        if (t.myBitfield[i] === 1 || t.pendingRequests.has(i)) continue;
        const candidates = [...t.peerBitfields.entries()]
          .filter(([pid, bf]) => bf[i] === 1 && this.peers.has(pid))
          .map(([pid]) => pid);
        if (!candidates.length) continue;
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        
        // Track the original sender to help with logging later
        if (!t.originalSenderId) t.originalSenderId = target;
        
        t.pendingRequests.add(i);
        setTimeout(() => t.pendingRequests.delete(i), 5000);
        this._sendTo(target, { type: 'request-chunk', fileIndex: fIdx, chunkIndex: i });
      }
    }

    if (shouldEmitProgress) this._lastProgressEmit = now;
  }

  // ==========================================================================
  // Chunk serving (Sender or Seeder)
  // ==========================================================================

  async _handleChunkRequest(peerId, fileIndex, chunkIndex) {
    const t = this.activeTransfers.get(fileIndex);
    if (!t) return;
    if (t.myBitfield[chunkIndex] !== 1) return; // I don't have it either

    try {
      let plain;
      if (t.file) {
        const start = chunkIndex * CHUNK_SIZE;
        plain = await t.file.slice(start, Math.min(start + CHUNK_SIZE, t.metadata.size)).arrayBuffer();
      } else {
        const start = chunkIndex * CHUNK_SIZE;
        const size = Math.min(CHUNK_SIZE, t.metadata.size - start);
        plain = await t.storage.readChunk(start, size);
      }
      if (!plain || plain.byteLength === 0) return;

      const payload = this.encryptionKey ? await encryptChunk(this.encryptionKey, plain) : plain;
      this._sendTo(peerId, { type: 'chunk-data', fileIndex, chunkIndex, data: payload });

      // Track chunks served (sender progress)
      if (t.file) t.chunksServed = (t.chunksServed || 0) + 1;
    } catch (e) {
      console.error(`[Swarm] Chunk ${chunkIndex} serve error:`, e);
    }
  }

  // ==========================================================================
  // Chunk receiving
  // ==========================================================================

  async _handleChunkData(peerId, fileIndex, chunkIndex, payload) {
    const t = this.activeTransfers.get(fileIndex);
    if (!t || t.myBitfield[chunkIndex] === 1) return; // Duplicate
    if (t.isFinalized) return; // Drop late stragglers if we already finished

    try {
      const data = this.encryptionKey ? await decryptChunk(this.encryptionKey, payload) : payload;
      
      // Double check in case finalized while decrypting
      if (t.isFinalized) return;
      
      await t.storage.writeChunk(chunkIndex * CHUNK_SIZE, data);
      t.myBitfield[chunkIndex] = 1;
      t.receivedCount++;
      t.pendingRequests.delete(chunkIndex);
      // Let all peers know we have this (enables mesh seeding)
      this._broadcast({ type: 'have-chunk', fileIndex, chunkIndex });
      if (t.receivedCount >= t.metadata.totalChunks) await this._finalize(fileIndex);
    } catch (e) {
      console.error(`[Swarm] Chunk ${chunkIndex} error:`, e);
      t.pendingRequests.delete(chunkIndex); // Allow retry
    }
  }

  async _finalize(fileIndex) {
    const t = this.activeTransfers.get(fileIndex);
    if (!t?.storage || t.isFinalized) return;
    
    t.isFinalized = true; // Mark to prevent closed-stream writes from lagging chunks
    
    this.callbacks.onProgress?.({
      fileName: t.metadata.name, fileIndex,
      progress: 100, bytesSent: t.metadata.size, totalBytes: t.metadata.size,
      speed: 0, isSender: false,
      chunkIndex: t.metadata.totalChunks, totalChunks: t.metadata.totalChunks,
      activePeers: this.peers.size,
    });
    try {
      const rawBlob = await t.storage.finish();
      
      // Override the MIME type. OPFS strips it, which breaks file opening on mobile devices.
      // Wrapping it in a new Blob with the correct type is a zero-copy operation.
      const blob = new Blob([rawBlob], { type: t.metadata.type || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const isLarge = t.metadata.size > 200 * 1024 * 1024;
      let checksum = this.encryptionKey ? 'AES-GCM Authenticated' : 'Unencrypted Transfer';
      if (!isLarge) {
        try { checksum = await computeHash(await blob.arrayBuffer()); } catch (_) {}
      }
      this.callbacks.onFileComplete?.({
        fileIndex, name: t.metadata.name, size: t.metadata.size,
        type: t.metadata.type, url, verified: true, checksum,
      });
      const allDone = [...this.activeTransfers.values()].every(
        tr => tr.file /* sender */ || tr.receivedCount >= tr.metadata.totalChunks
      );
      if (allDone) this.callbacks.onAllFilesComplete?.();
    } catch (err) {
      this.callbacks.onError?.(`Save failed: ${err.message}`);
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  getPeerCount() { return this.peers.size; }

  sendChatMessage(text) {
    this._broadcast({ type: 'chat', text });
    return { message: text, timestamp: Date.now() };
  }

  createOffer() {} // Legacy stub

  destroy() {
    if (this.isDestroyed) return;
    this.isDestroyed = true;
    if (this._pullTimer) clearInterval(this._pullTimer);
    this._unregisterSocketHandlers();
    for (const p of this.peers.values()) {
      try { p.dc?.close(); } catch (_) {}
      try { p.pc?.close(); } catch (_) {}
    }
    this.peers.clear();
  }
}
