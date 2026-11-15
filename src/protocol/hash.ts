import { concat, keccak256, numberToHex } from 'viem';
import { actionAmount, actionCode, type Action, type TurnEnvelope } from './schema.js';

/** Exact eight-word order from https://agentgames.zkverify.io/build#steal-the-vfy. */
export function publicInputsWords(envelope: TurnEnvelope, action: Action): readonly bigint[] {
  return [
    BigInt(envelope.strategyCommitment.hash),
    BigInt(`0x${envelope.matchId.replace(/-/g, '')}`),
    BigInt(envelope.turn),
    BigInt(envelope.state.selfBalance),
    BigInt(envelope.state.opponentBalance),
    actionCode(action),
    actionAmount(action),
    1n,
  ];
}

export function publicInputsHash(envelope: TurnEnvelope, action: Action): `0x${string}` {
  return keccak256(concat(publicInputsWords(envelope, action).map((word) => numberToHex(word, { size: 32 }))));
}
