import { actionSchema, type Action, type TurnEnvelope } from '../protocol/schema.js';
import { OFFICIAL_CIRCUIT, type CircuitContract, type PolicyState, type StrategyParams } from './contract.js';
import { STRATEGY_PARAMS } from './params.js';

export function policyState(envelope: TurnEnvelope): Readonly<PolicyState> {
  return Object.freeze({
    turn: envelope.turn,
    selfBalance: BigInt(envelope.state.selfBalance),
    opponentBalance: BigInt(envelope.state.opponentBalance),
    selfFortifiedUntilTurn: envelope.state.selfFortifiedUntilTurn,
    opponentFortifiedUntilTurn: envelope.state.opponentFortifiedUntilTurn,
  });
}

/** Pure policy boundary: no model, I/O, clock, randomness, or mutable match history. */
export function policy(
  state: Readonly<PolicyState>,
  params: StrategyParams | undefined = STRATEGY_PARAMS,
  contract: CircuitContract | undefined = OFFICIAL_CIRCUIT,
): Action {
  if (!contract || !params) throw new Error('Official circuit contract and private parameters are required');
  contract.validateParams(params);
  return Object.freeze(actionSchema.parse(contract.policy(state, params)));
}
