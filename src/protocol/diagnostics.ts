import type { z } from 'zod';

const fields = new Set([
  'protocolVersion', 'eventId', 'mode', 'matchId', 'turn', 'issuedAt', 'deadlineAt',
  'state', 'state.selfBalance', 'state.opponentBalance',
  'state.selfFortifiedUntilTurn', 'state.opponentFortifiedUntilTurn',
  'strategyCommitment', 'strategyCommitment.hash', 'resolverVersion', 'nonce',
]);
const codes = new Set(['invalid_type', 'invalid_value', 'invalid_format', 'too_small', 'too_big', 'custom']);

/** Never forward Zod messages, input values, unknown keys, or received enum values. */
export function validationSummary(issues: readonly z.core.$ZodIssue[]): readonly { field: string; code: string }[] {
  return issues.slice(0, 20).map((issue) => {
    const path = issue.path.map((part) => typeof part === 'string' ? part : '?').join('.');
    return { field: fields.has(path) ? path : 'envelope', code: codes.has(issue.code) ? issue.code : 'invalid' };
  });
}

export function commitmentShape(input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !Object.hasOwn(input, 'strategyCommitment')) return 'missing';
  const value = (input as Record<string, unknown>).strategyCommitment;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'string') return 'string';
  return 'other';
}

export function logValidationFailure(issues: readonly z.core.$ZodIssue[], input?: unknown): void {
  const shape = issues.some((issue) => issue.path[0] === 'strategyCommitment') ? { commitmentShape: commitmentShape(input) } : {};
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'invalid_envelope', issues: validationSummary(issues), ...shape })}\n`);
}

export function logRequestRejection(status: number, code: string): void {
  const permitted = new Set(['INVALID_JSON', 'STALE_REQUEST', 'INVALID_ENVELOPE', 'INVALID_SIGNATURE', 'EXPECTED_JSON', 'BODY_TOO_LARGE', 'UNSUPPORTED_ENCODING']);
  if (!permitted.has(code)) return;
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), event: 'request_rejected', status, code })}\n`);
}
