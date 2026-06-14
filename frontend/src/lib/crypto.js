// ============================================================================
// Zero-Knowledge Encryption (Web Crypto API)
// ============================================================================
//
// This module provides AES-GCM encryption for file chunks.
// The encryption key is generated in the browser and passed via the URL hash,
// so the signaling server (and any relay) never sees the raw file data.

/**
 * Generate a new AES-GCM 256-bit encryption key.
 * @returns {Promise<CryptoKey>} The generated key.
 */
export async function generateEncryptionKey() {
  return await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true, // Extractable so we can export it to a base64 string
    ['encrypt', 'decrypt']
  );
}

/**
 * Export a CryptoKey to a URL-safe base64 string.
 * @param {CryptoKey} key 
 * @returns {Promise<string>}
 */
export async function exportKey(key) {
  const exported = await window.crypto.subtle.exportKey('raw', key);
  const exportedKeyBuffer = new Uint8Array(exported);
  
  // Convert ArrayBuffer to base64
  let binary = '';
  for (let i = 0; i < exportedKeyBuffer.byteLength; i++) {
    binary += String.fromCharCode(exportedKeyBuffer[i]);
  }
  
  // URL-safe base64
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Import a CryptoKey from a URL-safe base64 string.
 * @param {string} base64String 
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(base64String) {
  // Restore standard base64 characters
  let base64 = base64String.replace(/-/g, '+').replace(/_/g, '/');
  // Pad with '=' if needed
  while (base64.length % 4) {
    base64 += '=';
  }
  
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  
  return await window.crypto.subtle.importKey(
    'raw',
    bytes.buffer,
    'AES-GCM',
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypt a chunk of data (ArrayBuffer) using the given AES-GCM key.
 * Prepends the 12-byte IV to the encrypted data so it can be decrypted.
 * 
 * @param {CryptoKey} key 
 * @param {ArrayBuffer} data 
 * @returns {Promise<ArrayBuffer>} The encrypted data with IV prepended.
 */
export async function encryptChunk(key, data) {
  // Generate a random 12-byte Initialization Vector (IV) for AES-GCM
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  
  const encrypted = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    data
  );
  
  // Combine IV and encrypted data into a single ArrayBuffer
  const combined = new Uint8Array(iv.byteLength + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.byteLength);
  
  return combined.buffer;
}

/**
 * Decrypt a chunk of data (ArrayBuffer) using the given AES-GCM key.
 * Expects the 12-byte IV to be prepended to the data.
 * 
 * @param {CryptoKey} key 
 * @param {ArrayBuffer} encryptedData 
 * @returns {Promise<ArrayBuffer>} The decrypted original data.
 */
export async function decryptChunk(key, encryptedData) {
  // Extract the 12-byte IV from the beginning
  const iv = new Uint8Array(encryptedData, 0, 12);
  const data = new Uint8Array(encryptedData, 12);
  
  return await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv
    },
    key,
    data
  );
}
