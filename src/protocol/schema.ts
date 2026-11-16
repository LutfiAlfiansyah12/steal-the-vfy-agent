import { z } from 'zod';

export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const uint256 = z.string().regex(/^(0|[1-9][0-9]{0,77})$/).refine((s) => /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) < (1n << 256n));
const timestamp = z.iso.datetime({ offset: true });
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const actionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('HOLD') }),
  z.strictObject({ type: z.literal('FORTIFY') }),
  z.strictObject({ type: z.literal('EXTRACT'), amount: z.number().int().min(1).max(10) }),
]);
export type Action = z.infer<typeof actionSchema>;
export const HOLD = Object.freeze({ type: 'HOLD' } as const);
export const actionCode = (action: Action): bigint => ({ HOLD: 0n, FORTIFY: 1n, EXTRACT: 2n })[action.type];
export const actionAmount = (action: Action): bigint => action.type === 'EXTRACT' ? BigInt(action.amount) : 0n;

export const turnSchema = z.object({
  protocolVersion: z.literal('v1'),
  eventId: z.literal('steal-the-vfy'),
  mode: z.enum(['practice', 'competition']),
  matchId: z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/),
  turn: z.number().int().min(0).max(20),
  issuedAt: timestamp,
  deadlineAt: timestamp,
  state: z.object({
    selfBalance: uint256,
    opponentBalance: uint256,
    selfFortifiedUntilTurn: z.number().int().min(0).max(20).nullable(),
    opponentFortifiedUntilTurn: z.number().int().min(0).max(20).nullable(),
  }),
  // Accept a supplied bare hash as well as { hash }. Normalize its representation
  // only; never invent a commitment for null/missing input.
  strategyCommitment: z.preprocess(
    (value) => typeof value === 'string' ? { hash: value } : value,
    z.object({ hash }),
  ),
  resolverVersion: z.literal('v1'),
  nonce: z.string().min(1).max(256),
});
export type TurnEnvelope = z.infer<typeof turnSchema>;
export const preflightSchema = z.object({
  type: z.literal('agent-games.preflight.v1'),
  agent_id: z.string().min(1).max(128),
  issued_at: timestamp,
  nonce: z.string().min(1).max(256),
});
export type ProofBundle = { proof: Record<string, unknown>; publicSignals: string[] };
export type TurnResponse = {
  matchId: string;
  turn: number;
  action: Action;
  policyProof: { circuitVersion: 'v1'; publicInputsHash: `0x${string}`; proofReference?: string };
  agentTimestamp: string;
  idempotencyKey: string;
  proof?: Record<string, unknown>;
  public_signals?: string[];
};

export function freshTimestamp(issuedAt: string, now: number, maxAgeMs: number, skewMs: number): boolean {
  const issued = Date.parse(issuedAt);
  return Number.isFinite(issued) && issued <= now + skewMs && issued >= now - maxAgeMs;
}
