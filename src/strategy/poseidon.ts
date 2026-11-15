import { buildPoseidon } from 'circomlibjs';
import { FIELD_MODULUS } from '../protocol/schema.js';

let instance: ReturnType<typeof buildPoseidon> | undefined;

export async function poseidonHash(words: readonly bigint[]): Promise<bigint> {
  if (!words.length || words.some((word) => word < 0n || word >= FIELD_MODULUS)) throw new Error('Invalid Poseidon field input');
  instance ??= buildPoseidon();
  const poseidon = await instance;
  return BigInt(poseidon.F.toString(poseidon([...words])));
}
