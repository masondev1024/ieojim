const encoder = new TextEncoder();

export const randomId = (prefix: string): string => `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;

export const randomToken = (): string => {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

export const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

export const jsonHash = async (value: unknown): Promise<string> => sha256Hex(JSON.stringify(value));
