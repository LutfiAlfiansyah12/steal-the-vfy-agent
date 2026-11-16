import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Config } from './config.js';
import { SIGNATURE_HEADER, sign, verifySignature } from './protocol/hmac.js';
import { freshTimestamp, preflightSchema, turnSchema } from './protocol/schema.js';
import { logRequestRejection, logValidationFailure } from './protocol/diagnostics.js';
import { TurnFailure } from './runtime/deadline.js';
import type { TurnService } from './runtime/turn-service.js';

class HttpError extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }

async function rawBody(request: IncomingMessage): Promise<Buffer> {
  const max = 32 * 1024;
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > max)) throw new HttpError(413, 'BODY_TOO_LARGE');
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new HttpError(415, 'UNSUPPORTED_ENCODING');
  const chunks: Buffer[] = [];
  let size = 0;
  // Read bytes without any JSON middleware, decoding, reserialization, or decompression.
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > max) throw new HttpError(413, 'BODY_TOO_LARGE');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export function createAgentServer(config: Config, service: TurnService): Server {
  function send(response: ServerResponse, status: number, body: string): void {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      [SIGNATURE_HEADER]: sign(body, config.hmacSecret),
    });
    response.end(body);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const receivedAt = Date.now();
    if (request.method === 'GET' && request.url === '/healthz') return send(response, 200, '{"ok":true}');
    if (request.method === 'GET' && request.url === '/readyz') return send(response, service.ready ? 200 : 503, JSON.stringify({ ready: service.ready }));
    if (request.url !== '/agent') throw new HttpError(404, 'NOT_FOUND');
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED');
    // Reject ambiguous duplicate signature headers rather than choosing one.
    const headerCount = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i]?.toLowerCase() === SIGNATURE_HEADER).length;
    const header = request.headers[SIGNATURE_HEADER];
    const raw = await rawBody(request);
    if (headerCount !== 1 || typeof header !== 'string' || !verifySignature(raw, header, config.hmacSecret)) throw new HttpError(401, 'INVALID_SIGNATURE');
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')) throw new HttpError(415, 'EXPECTED_JSON');
    let input: unknown;
    try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { throw new HttpError(400, 'INVALID_JSON'); }
    const preflight = preflightSchema.safeParse(input);
    if (preflight.success) {
      if (!freshTimestamp(preflight.data.issued_at, Date.now(), config.maxAgeMs, config.clockSkewMs)) throw new HttpError(400, 'STALE_REQUEST');
      return send(response, 200, '{"ok":true,"protocolVersion":"v1"}');
    }
    const parsed = turnSchema.safeParse(input);
    if (!parsed.success) {
      logValidationFailure(parsed.error.issues);
      throw new HttpError(400, 'INVALID_ENVELOPE');
    }
    const envelope = parsed.data;
    if (!freshTimestamp(envelope.issuedAt, Date.now(), config.maxAgeMs, config.clockSkewMs) || Date.parse(envelope.deadlineAt) < Date.parse(envelope.issuedAt)) throw new HttpError(400, 'STALE_REQUEST');
    const body = await service.handle(envelope, receivedAt);
    send(response, 200, body);
  }

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const unavailable = error instanceof TurnFailure && ['STORAGE', 'OVERLOADED', 'DEADLINE'].includes(error.code);
      const status = error instanceof HttpError ? error.status : error instanceof TurnFailure && error.code === 'CONFLICT' ? 409 : unavailable ? 503 : 500;
      const code = error instanceof HttpError ? error.code : status === 409 ? 'TURN_CONFLICT' : unavailable ? 'TURN_UNAVAILABLE' : 'INTERNAL_ERROR';
      logRequestRejection(status, code);
      send(response, status, JSON.stringify({ error: code }));
      request.resume();
    });
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.timeout = 60_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 40;
  server.maxConnections = 128;
  return server;
}
