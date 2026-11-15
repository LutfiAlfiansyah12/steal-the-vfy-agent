import { poseidonHash } from './poseidon.js';
import { FIELD_MODULUS } from '../protocol/schema.js';
import type { CircuitContract, StrategyParams } from './contract.js';

export async function computeCommitment(contract: CircuitContract, params: StrategyParams, salt: bigint): Promise<`0x${string}`> {
  contract.validateParams(params);
  if (salt < 0n || salt >= FIELD_MODULUS) throw new Error('Invalid strategy salt');
  // The contract must supply the EXACT input order/arity; never sort keys or infer it.
  const words = contract.commitmentInputs(params, salt);
  if (!words.length || words.some((word) => word < 0n || word >= FIELD_MODULUS)) throw new Error('Invalid commitment contract');
  const commitment = await poseidonHash(words);
  return `0x${commitment.toString(16).padStart(64, '0')}`;
}
