import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-agent-games-signature';

export function sign(raw: Uint8Array | string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

export function verifySignature(raw: Uint8Array, header: string | undefined, secret: string): boolean {
  // /guide specifies unprefixed HMAC-SHA256 hex. Decode only after exact-length validation.
  if (!header || !/^[a-fA-F0-9]{64}$/.test(header)) return false;
  return timingSafeEqual(Buffer.from(sign(raw, secret), 'hex'), Buffer.from(header, 'hex'));
}
