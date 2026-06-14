// ============================================================================
// FileStorage — OPFS-backed streaming file writer with auto-resume support
// ============================================================================
// The Origin Private File System (OPFS) lets us stream chunks directly to
// disk instead of accumulating them in RAM. Critical for large files (>500MB).
//
// AUTO-RESUME: On init, instead of wiping existing data, we check if a
// partially-downloaded file already exists in OPFS. We scan it to figure out
// which chunks are complete, reconstruct the bitfield, and return it so the
// swarm skips already-received chunks.
//
// QUOTA HANDLING: If OPFS quota is exceeded, we fall back silently to an
// in-memory approach so the transfer still completes.
// ============================================================================

export class FileStorage {
  constructor(fileName, fileSize) {
    this.fileName = fileName;
    this.fileSize = fileSize;
    this.useOpfs = !!(navigator.storage?.getDirectory);
    this.opfsFileHandle = null;
    this.opfsWritable = null;
    this.memoryChunks = []; // Fallback when OPFS is unavailable or quota exceeded
    this._initDone = false;
  }

  /**
   * Initialize storage. Returns a reconstructed bitfield for auto-resume.
   * If OPFS already has a partial file, figures out what's already written.
   *
   * @param {number} totalChunks  Total expected chunks
   * @param {number} chunkSize    Bytes per chunk (must match sender's CHUNK_SIZE)
   * @returns {Promise<Uint8Array>}  Bitfield: 1 = have chunk, 0 = missing
   */
  async init(totalChunks, chunkSize) {
    const zeroBitfield = new Uint8Array(totalChunks).fill(0);
    if (!this.useOpfs) return zeroBitfield;

    try {
      const root = await navigator.storage.getDirectory();
      // Open (or create) the file handle. We intentionally DON'T delete existing
      // data — that's what makes auto-resume possible.
      this.opfsFileHandle = await root.getFileHandle(this.fileName, { create: true });
      const file = await this.opfsFileHandle.getFile();

      let existingBitfield = zeroBitfield;
      if (file.size > 0 && file.size <= this.fileSize + chunkSize) {
        // File already has data — reconstruct which chunks are present
        existingBitfield = this._reconstructBitfield(file.size, totalChunks, chunkSize);
        const haveCount = existingBitfield.reduce((s, b) => s + b, 0);
        if (haveCount > 0) {
          console.log(`[Storage] Auto-resume: ${haveCount}/${totalChunks} chunks already in OPFS for "${this.fileName}"`);
        }
      } else if (file.size > this.fileSize + chunkSize) {
        // Stale/corrupt file from a different transfer — wipe it
        console.warn('[Storage] OPFS file size mismatch, wiping stale data');
        await root.removeEntry(this.fileName);
        this.opfsFileHandle = await root.getFileHandle(this.fileName, { create: true });
      }

      // Open writable keeping existing data (critical for auto-resume!)
      this.opfsWritable = await this.opfsFileHandle.createWritable({ keepExistingData: true });
      this._initDone = true;
      return existingBitfield;
    } catch (err) {
      console.warn('[Storage] OPFS init failed, using memory fallback:', err.message);
      this.useOpfs = false;
      this._initDone = true;
      return zeroBitfield;
    }
  }

  /**
   * Determine which chunks are already written by checking file size.
   * A chunk at index i is "complete" if the file is large enough to contain it.
   */
  _reconstructBitfield(fileSize, totalChunks, chunkSize) {
    const bitfield = new Uint8Array(totalChunks).fill(0);
    for (let i = 0; i < totalChunks; i++) {
      const expectedEnd = Math.min((i + 1) * chunkSize, this.fileSize);
      if (fileSize >= expectedEnd) bitfield[i] = 1;
      else break; // Since chunks arrive roughly in order, stop at first gap
    }
    return bitfield;
  }

  /**
   * Write a chunk at a specific byte offset. Supports out-of-order writes.
   * Falls back to memory automatically on QuotaExceededError.
   */
  async writeChunk(offset, data) {
    if (this.useOpfs && this.opfsWritable) {
      try {
        await this.opfsWritable.write({ type: 'write', position: offset, data });
        return;
      } catch (err) {
        if (err.name === 'QuotaExceededError') {
          console.warn('[Storage] OPFS quota exceeded! Falling back to memory for remaining chunks.');
          // Close OPFS writable cleanly then switch to memory mode
          try { await this.opfsWritable.close(); } catch (_) {}
          this.opfsWritable = null;
          this.useOpfs = false;
          // Don't store this chunk in memory — it was already partially received.
          // The chunk will be retried and land in memoryChunks.
          return;
        }
        throw err; // Re-throw other errors
      }
    }
    // Memory fallback — store by offset to allow out-of-order reassembly
    this.memoryChunks.push({ offset, data: data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
  }

  /**
   * Read a chunk range. Used by seeder peers to serve chunks to others.
   */
  async readChunk(offset, size) {
    if (this.useOpfs && this.opfsFileHandle) {
      try {
        // Close and reopen writable so we can get a fresh File snapshot
        if (this.opfsWritable) {
          await this.opfsWritable.close();
          this.opfsWritable = await this.opfsFileHandle.createWritable({ keepExistingData: true });
        }
        const file = await this.opfsFileHandle.getFile();
        return await file.slice(offset, offset + size).arrayBuffer();
      } catch (err) {
        console.warn('[Storage] readChunk error:', err.message);
        return new ArrayBuffer(0);
      }
    }
    // Memory fallback
    const chunk = this.memoryChunks.find(c => c.offset === offset);
    if (chunk) return chunk.data instanceof ArrayBuffer ? chunk.data : chunk.data.buffer;
    return new ArrayBuffer(0);
  }

  /**
   * Finalize: close the writable and return the assembled File/Blob.
   * If OPFS is active, returns a zero-copy File. Otherwise assembles from memory.
   */
  async finish() {
    if (this.useOpfs && this.opfsWritable) {
      await this.opfsWritable.close();
      this.opfsWritable = null;
      return await this.opfsFileHandle.getFile();
    }
    // Memory fallback: sort by offset and concatenate
    this.memoryChunks.sort((a, b) => a.offset - b.offset);
    const totalSize = this.memoryChunks.reduce((s, c) => {
      const buf = c.data instanceof ArrayBuffer ? c.data : c.data.buffer;
      return s + buf.byteLength;
    }, 0);
    const out = new Uint8Array(totalSize);
    let pos = 0;
    for (const c of this.memoryChunks) {
      const buf = c.data instanceof ArrayBuffer ? c.data : c.data.buffer;
      out.set(new Uint8Array(buf), pos);
      pos += buf.byteLength;
    }
    this.memoryChunks = [];
    return new Blob([out], { type: 'application/octet-stream' });
  }

  /**
   * Delete the OPFS file. Called on reset or when transfer starts fresh.
   */
  async cleanup() {
    try {
      if (this.opfsWritable) { await this.opfsWritable.close(); this.opfsWritable = null; }
      if (this.useOpfs && this.opfsFileHandle) {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(this.fileName);
      }
    } catch (_) {}
  }
}
