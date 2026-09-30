const encoder = new TextEncoder();

const decoder = new TextDecoder();

export interface SealedSecret {
  /** Format version, so the key or algorithm can rotate later. */
  v: 1;
  iv: string;
  data: string;
}

async function importKey(base64Key: string): Promise<CryptoKey> {
  const raw = fromBase64(base64Key);

  if (raw.byteLength !== 32) {
    throw new Error("LINK_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  }

  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encrypts a secret with AES-256-GCM. The additional data binds the ciphertext
 * to its owner, so a sealed key copied into another user's grant fails to open.
 */
export async function seal(
  plaintext: string,
  base64Key: string,
  owner: string,
): Promise<SealedSecret> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));

  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(owner) },
    key,
    encoder.encode(plaintext),
  );

  return { v: 1, iv: toBase64(iv), data: toBase64(new Uint8Array(data)) };
}

export async function open(
  sealed: SealedSecret,
  base64Key: string,
  owner: string,
): Promise<string> {
  if (sealed.v !== 1) {
    throw new Error("Unsupported sealed secret version.");
  }

  const key = await importKey(base64Key);

  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(sealed.iv),
      additionalData: encoder.encode(owner),
    },
    key,
    fromBase64(sealed.data),
  );

  return decoder.decode(plaintext);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}
