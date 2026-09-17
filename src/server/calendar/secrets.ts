import { sha256Hex } from '../crypto';
import { ApiException } from '../errors';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function encryptSecret(plaintext: string, serverSecret: string, aad: string): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await encryptionKey(serverSecret);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(plaintext));
  return `v1.${base64Url(iv)}.${base64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(ciphertext: string, serverSecret: string, aad: string): Promise<string> {
  const [version, rawIv, rawCiphertext] = ciphertext.split('.');
  if (version !== 'v1' || !rawIv || !rawCiphertext) throw new ApiException('SECRET_DECRYPTION_FAILED', '연결 정보를 확인할 수 없습니다. 다시 연결해 주세요.', 401);
  try {
    const key = await encryptionKey(serverSecret);
    const iv = asArrayBuffer(fromBase64Url(rawIv));
    const encrypted = asArrayBuffer(fromBase64Url(rawCiphertext));
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad) },
      key,
      encrypted,
    );
    return decoder.decode(decrypted);
  } catch {
    throw new ApiException('SECRET_DECRYPTION_FAILED', '연결 정보를 확인할 수 없습니다. 다시 연결해 주세요.', 401);
  }
}

export const secretDigest = (value: string): Promise<string> => sha256Hex(value);

async function encryptionKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) throw new ApiException('INVALID_AUTH_CONFIG', '로그인 연결을 확인해야 합니다. 잠시 후 다시 시도해 주세요.', 503);
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('ieojim-calendar-v1'), info: encoder.encode('calendar-token-encryption') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function base64Url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = `${value}${'='.repeat((4 - value.length % 4) % 4)}`.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
