/**
 * Native AES-IGE crypto provider for mtcute.
 *
 * Replaces @mtcute/wasm (WASM-based AES-IGE) with a pure Node.js
 * implementation using crypto.createCipheriv('aes-*-ecb').
 *
 * Why: the WASM provider allocates a ~100 MB linear memory region
 * and creates a new ArrayBuffer per ige256Encrypt/Decrypt call via
 * mem.slice(), causing unbounded heap growth during active hours.
 * This native implementation uses Node Buffers directly — no WASM,
 * no mem.slice(), no linear memory overhead.
 *
 * AES-IGE (Infinite Garble Extension) reference:
 *   Encryption:
 *     C[0] = AES_enc(P[0] ⊕ IV[0]) ⊕ IV[1]
 *     C[i] = AES_enc(P[i] ⊕ C[i-1]) ⊕ P[i-1]   (i ≥ 1)
 *   Decryption:
 *     P[0] = AES_dec(C[0] ⊕ IV[0]) ⊕ IV[1]
 *     P[i] = AES_dec(C[i] ⊕ P[i-1]) ⊕ C[i-1]   (i ≥ 1)
 *   where IV is 32 bytes: IV[0] = first 16, IV[1] = second 16.
 */

import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2 as pbkdf2cb, randomFillSync } from "node:crypto";
import { deflateSync, gunzipSync } from "node:zlib";
import { BaseCryptoProvider } from "@mtcute/core/utils.js";

const BLOCK_SIZE = 16; // AES block size in bytes

/** AES-IGE encryption using AES-ECB primitives. */
function igeEncrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const iv0 = iv.subarray(0, BLOCK_SIZE);
  const iv1 = iv.subarray(BLOCK_SIZE, BLOCK_SIZE * 2);

  const cipher = createCipheriv(`aes-${key.length * 8}-ecb`, key, null);
  cipher.setAutoPadding(false);

  const out = Buffer.allocUnsafe(data.length);
  let prevCipher = Buffer.from(iv0); // C[-1] = IV[0]
  let prevPlain = Buffer.from(iv1);  // P[-1] = IV[1]

  for (let off = 0; off < data.length; off += BLOCK_SIZE) {
    const plainBlock = Buffer.from(data.subarray(off, off + BLOCK_SIZE));
    // XOR P[i] with C[i-1]
    const xored = Buffer.allocUnsafe(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) xored[i] = plainBlock[i] ^ prevCipher[i];
    // AES_encrypt(xored)
    const encrypted = cipher.update(xored);
    // XOR with P[i-1] → C[i]
    const cipherBlock = Buffer.allocUnsafe(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) cipherBlock[i] = encrypted[i] ^ prevPlain[i];
    cipherBlock.copy(out, off);
    prevCipher = cipherBlock;
    prevPlain = plainBlock;
  }

  return out;
}

/** AES-IGE decryption. */
function igeDecrypt(data: Uint8Array, key: Uint8Array, iv: Uint8Array): Uint8Array {
  const iv0 = iv.subarray(0, BLOCK_SIZE);
  const iv1 = iv.subarray(BLOCK_SIZE, BLOCK_SIZE * 2);

  const decipher = createDecipheriv(`aes-${key.length * 8}-ecb`, key, null);
  decipher.setAutoPadding(false);

  const out = Buffer.allocUnsafe(data.length);
  let prevCipher = Buffer.from(iv0); // C[-1] = IV[0]
  let prevPlain = Buffer.from(iv1);  // P[-1] = IV[1]

  for (let off = 0; off < data.length; off += BLOCK_SIZE) {
    const cipherBlock = Buffer.from(data.subarray(off, off + BLOCK_SIZE));
    // XOR C[i] with P[i-1]
    const xored = Buffer.allocUnsafe(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) xored[i] = cipherBlock[i] ^ prevPlain[i];
    // AES_decrypt(xored)
    const decrypted = decipher.update(xored);
    // XOR with C[i-1] → P[i]
    const plainBlock = Buffer.allocUnsafe(BLOCK_SIZE);
    for (let i = 0; i < BLOCK_SIZE; i++) plainBlock[i] = decrypted[i] ^ prevCipher[i];
    plainBlock.copy(out, off);
    prevCipher = cipherBlock;
    prevPlain = plainBlock;
  }

  return out;
}

export class NativeCryptoProvider extends BaseCryptoProvider {
  createAesCtr(key: Uint8Array, iv: Uint8Array) {
    const cipher = createCipheriv(`aes-${key.length * 8}-ctr`, key, iv);
    return { process: (data: Uint8Array) => cipher.update(data) };
  }

  createAesIge(key: Uint8Array, iv: Uint8Array) {
    return {
      encrypt: (data: Uint8Array) => igeEncrypt(data, key, iv),
      decrypt: (data: Uint8Array) => igeDecrypt(data, key, iv),
    };
  }

  pbkdf2(
    password: Uint8Array,
    salt: Uint8Array,
    iterations: number,
    keylen = 64,
    algo = "sha512",
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) =>
      pbkdf2cb(password, salt, iterations, keylen, algo, (err, buf) =>
        err !== null ? reject(err) : resolve(buf),
      ),
    );
  }

  sha1(data: Uint8Array): Uint8Array {
    return createHash("sha1").update(data).digest();
  }

  sha256(data: Uint8Array): Uint8Array {
    return createHash("sha256").update(data).digest();
  }

  hmacSha256(data: Uint8Array, key: Uint8Array): Uint8Array {
    return createHmac("sha256", key).update(data).digest();
  }

  gzip(data: Uint8Array, maxSize: number): Uint8Array | null {
    try {
      return deflateSync(data, { maxOutputLength: maxSize });
    } catch (e: any) {
      if (e.code === "ERR_BUFFER_TOO_LARGE") return null;
      throw e;
    }
  }

  gunzip(data: Uint8Array): Uint8Array {
    return gunzipSync(data);
  }

  randomFill(buf: Uint8Array): void {
    randomFillSync(buf);
  }

  async initialize(): Promise<void> {
    // No WASM to load — everything uses node:crypto.
  }
}
