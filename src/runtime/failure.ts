import { TurnFailure } from './deadline.js';

const allowed = new Set(['INVALID_PROOF', 'VERIFICATION', 'UNAVAILABLE', 'DEADLINE', 'STORAGE', 'CONFLICT', 'OVERLOADED']);

/** Emit only a fixed failure class, never upstream response bodies or secrets. */
export function logTurnFailure(error: unknown): void {
  const code = error instanceof TurnFailure && allowed.has(error.code) ? error.code : 'UNKNOWN';
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'turn_failure', code })}\n`);
}
