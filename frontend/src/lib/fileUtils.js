// ============================================================================
// File Utility Functions
// ============================================================================
//
// Helper functions for file operations:
//   - Formatting file sizes (bytes → human-readable)
//   - Formatting transfer speeds
//   - Computing SHA-256 hashes for integrity verification
//   - Splitting files into chunks for transmission
//
// WHY SHA-256?
// When sending files over a network, data can get corrupted. By hashing the
// file before sending and after receiving, we can verify nothing was lost
// or changed during transfer. SHA-256 is a cryptographic hash — even a
// single bit flip produces a completely different hash.
//
// ============================================================================

/**
 * Format a byte count into a human-readable string.
 * Examples: 1024 → "1.00 KB", 1048576 → "1.00 MB"
 * 
 * Uses the binary system (1 KB = 1024 bytes) which is what most
 * operating systems display.
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  // Math.log(bytes) / Math.log(1024) gives us which "tier" we're in
  // e.g., 1500 bytes → log(1500)/log(1024) ≈ 1.05 → tier 1 (KB)
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  // Divide by 1024^tier to get the value in that unit
  const value = bytes / Math.pow(1024, i);
  
  return `${value.toFixed(2)} ${units[i]}`;
}

/**
 * Format transfer speed (bytes per second) into a human-readable string.
 * Examples: 1048576 → "1.00 MB/s"
 */
export function formatSpeed(bytesPerSecond) {
  // Below 100 B/s is effectively idle — show as 0 B/s to avoid noise
  if (bytesPerSecond < 100) return '0 B/s';
  return `${formatFileSize(bytesPerSecond)}/s`;
}

/**
 * Format duration in seconds to human-readable string.
 * Examples: 65 → "1m 5s", 3661 → "1h 1m 1s"
 */
export function formatDuration(seconds) {
  if (seconds < 1) return 'less than a second';
  
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  
  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0) parts.push(`${s}s`);
  
  return parts.join(' ');
}

/**
 * Compute SHA-256 hash of an ArrayBuffer using the Web Crypto API.
 * 
 * WHY WEB CRYPTO API?
 * - Built into all modern browsers — no library needed
 * - Runs in hardware on most devices (very fast)
 * - Returns a proper cryptographic hash
 * 
 * The hash is returned as a hex string (e.g., "a1b2c3d4...")
 * 
 * @param {ArrayBuffer} buffer - The data to hash
 * @returns {Promise<string>} The hex-encoded SHA-256 hash
 */
export async function computeHash(buffer) {
  // crypto.subtle.digest returns a Promise<ArrayBuffer> of the hash
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  
  // Convert the hash ArrayBuffer to a hex string
  // Each byte becomes two hex characters (e.g., 255 → "ff")
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  
  return hashHex;
}

/**
 * Compute SHA-256 hash of a File object.
 * Reads the entire file into memory and hashes it.
 * 
 * @param {File} file - The file to hash
 * @returns {Promise<string>} The hex-encoded SHA-256 hash
 */
export async function hashFile(file) {
  const buffer = await file.arrayBuffer();
  return computeHash(buffer);
}

// The chunk size for splitting files. 64KB is a good balance:
//   - Small enough to show smooth progress updates
//   - Large enough to avoid excessive overhead from message framing
//   - Fits within WebRTC DataChannel's default buffer limits
export const CHUNK_SIZE = 64 * 1024; // 64 KB

/**
 * Split a File into chunks as ArrayBuffers.
 * Returns an async generator that yields chunks one at a time.
 * 
 * WHY A GENERATOR?
 * Reading the entire file into memory at once would crash the browser
 * for large files (imagine loading a 2GB video into RAM). Instead,
 * we read and process one chunk at a time using File.slice().
 * 
 * @param {File} file - The file to chunk
 * @param {number} chunkSize - Size of each chunk in bytes
 * @yields {{ chunk: ArrayBuffer, index: number, totalChunks: number }}
 */
export async function* chunkFile(file, chunkSize = CHUNK_SIZE) {
  const totalChunks = Math.ceil(file.size / chunkSize);
  
  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    
    // File.slice() returns a Blob (a reference, not a copy — very efficient)
    // .arrayBuffer() reads just that slice into memory
    const blob = file.slice(start, end);
    const chunk = await blob.arrayBuffer();
    
    yield { chunk, index: i, totalChunks };
  }
}

/**
 * Get an appropriate icon name for a file based on its MIME type.
 * Used by the UI to show relevant file type icons.
 */
export function getFileIcon(mimeType) {
  if (!mimeType) return 'File';
  if (mimeType.startsWith('image/')) return 'Image';
  if (mimeType.startsWith('video/')) return 'Video';
  if (mimeType.startsWith('audio/')) return 'Music';
  if (mimeType.startsWith('text/')) return 'FileText';
  if (mimeType.includes('pdf')) return 'FileText';
  if (mimeType.includes('zip') || mimeType.includes('rar') || mimeType.includes('tar')) return 'Archive';
  if (mimeType.includes('javascript') || mimeType.includes('json') || mimeType.includes('html') || mimeType.includes('css')) return 'FileCode';
  return 'File';
}

/**
 * Generate a unique ID for file transfers.
 * Used to track multiple simultaneous transfers.
 */
export function generateFileId() {
  return `file_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
