import { publicInputsWords } from '../protocol/hash.js';
import { FIELD_MODULUS, actionAmount, actionCode, actionSchema, type Action, type TurnEnvelope } from '../protocol/schema.js';
import type { CircuitContract, CircuitInput, PolicyState, StrategyParams } from './contract.js';
import { poseidonHash } from './poseidon.js';

function canonicalField(value: bigint): bigint {
  if (typeof value !== 'bigint' || value < 0n || value >= FIELD_MODULUS) throw new Error('Circuit field element out of range');
  return value;
}

export function validateVfyParams(params: StrategyParams): void {
  if (!Array.isArray(params) || params.length !== 8) throw new Error('Expected eight private circuit parameters');
  for (const value of params) canonicalField(value);
  if (params[0] < 1n || params[0] > 10n) throw new Error('Private extraction parameter out of range');
  if (params[3] !== 0n && params[3] !== 1n) throw new Error('Private policy flag must be boolean');
  if (params.slice(4).some((value) => value !== 0n)) throw new Error('Reserved circuit parameters must be zero');
}

/** Circom LessThan(16): preserve its exact field/difference semantics, never coerce to Number. */
function circuitLessThan(a: bigint, b: bigint): boolean {
  canonicalField(a);
  canonicalField(b);
  const shifted = (65536n + a - b + FIELD_MODULUS) % FIELD_MODULUS;
  if (shifted >= 131072n) throw new Error('State outside circuit comparison domain');
  return shifted < 65536n;
}

/** Transcribed from the pinned VfyPolicyProof_154 WASM; these are circuit rules, not chosen parameters. */
export function vfyPolicy(state: Readonly<PolicyState>, params: StrategyParams): Action {
  validateVfyParams(params);
  const low = circuitLessThan(state.selfBalance, params[1]);
  const rich = circuitLessThan(params[2], state.opponentBalance);
  if (low) return { type: 'FORTIFY' };
  if (rich && params[3] === 0n) return { type: 'EXTRACT', amount: Number(params[0]) };
  return { type: 'HOLD' };
}

function wordsFor(envelope: TurnEnvelope, action: Action): readonly bigint[] {
  actionSchema.parse(action);
  const words = publicInputsWords(envelope, action);
  for (const word of words) canonicalField(word);
  return words;
}

function buildWitness(envelope: TurnEnvelope, action: Action, params: StrategyParams, salt: bigint): CircuitInput {
  validateVfyParams(params);
  canonicalField(salt);
  wordsFor(envelope, action);
  const expected = vfyPolicy({
    turn: envelope.turn,
    selfBalance: BigInt(envelope.state.selfBalance),
    opponentBalance: BigInt(envelope.state.opponentBalance),
    selfFortifiedUntilTurn: envelope.state.selfFortifiedUntilTurn,
    opponentFortifiedUntilTurn: envelope.state.opponentFortifiedUntilTurn,
  }, params);
  if (actionCode(action) !== actionCode(expected) || actionAmount(action) !== actionAmount(expected)) throw new Error('Action does not match the committed circuit policy');
  return Object.freeze({
    commitment: BigInt(envelope.strategyCommitment.hash).toString(),
    matchId: BigInt(`0x${envelope.matchId.replace(/-/g, '')}`).toString(),
    turnNumber: BigInt(envelope.turn).toString(),
    selfBalance: BigInt(envelope.state.selfBalance).toString(),
    opponentBalance: BigInt(envelope.state.opponentBalance).toString(),
    action: actionCode(action).toString(),
    amount: actionAmount(action).toString(),
    circuitVersion: '1',
    salt: salt.toString(),
    strategyParams: Object.freeze(params.map(String)),
  });
}

export const VFY_V1_CIRCUIT: CircuitContract = Object.freeze({
  source: 'https://agentgames.zkverify.io/circuits/vfy-policy.wasm#sha256=bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2',
  circuitVersion: 'v1',
  validateParams: validateVfyParams,
  policy: vfyPolicy,
  commitmentInputs(params: StrategyParams, salt: bigint): readonly bigint[] {
    validateVfyParams(params);
    canonicalField(salt);
    return [...params, salt];
  },
  buildWitness,
  async expectedPublicSignals(envelope: TurnEnvelope, action: Action): Promise<readonly string[]> {
    const words = wordsFor(envelope, action);
    const matchId = words[1]!;
    const turnNumber = words[2]!;
    const version = words[7]!;
    const binding = await poseidonHash([matchId, turnNumber, version]);
    return Object.freeze([binding, ...words].map(String));
  },
});
