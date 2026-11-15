import type { Action, TurnEnvelope } from '../protocol/schema.js';
import { VFY_V1_CIRCUIT } from './vfy-v1.js';

export type StrategyParams = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
export type CircuitInput = Readonly<Record<string, string | readonly string[]>>;
export interface PolicyState {
  readonly turn: number;
  readonly selfBalance: bigint;
  readonly opponentBalance: bigint;
  readonly selfFortifiedUntilTurn: number | null;
  readonly opponentFortifiedUntilTurn: number | null;
}

/** Verify these mappings against the official circuit artifacts or an official SDK. */
export interface CircuitContract {
  readonly source: string;
  readonly circuitVersion: 'v1';
  validateParams(params: StrategyParams): void;
  policy(state: Readonly<PolicyState>, params: StrategyParams): Action;
  commitmentInputs(params: StrategyParams, salt: bigint): readonly bigint[];
  buildWitness(envelope: TurnEnvelope, action: Action, params: StrategyParams, salt: bigint): CircuitInput;
  expectedPublicSignals(envelope: TurnEnvelope, action: Action): Promise<readonly string[]>;
}

// Recovered from the pinned official WASM and checked with real proofs against its zkey.
// This supplies circuit semantics only. The owner's strategy parameter values remain unset.
export const OFFICIAL_CIRCUIT: CircuitContract = VFY_V1_CIRCUIT;
