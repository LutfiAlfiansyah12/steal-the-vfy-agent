import { FIELD_MODULUS } from '../protocol/schema.js';
import type { StrategyParams } from './contract.js';
import { validateVfyParams } from './vfy-v1.js';

// TODO(owner): choose your own strategy parameters. Supply STRATEGY_PARAMS_JSON
// privately through the environment as the ordered eight-element circuit array.
// Do NOT replace this marker with secret values in source control or send them to an AI.
// No default parameter values or competitive strategy are provided.
export const STRATEGY_PARAMS: StrategyParams | undefined = undefined;

export function fieldElement(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,77}|0x[0-9a-fA-F]{1,64})$/.test(value)) throw new Error('Invalid private field element');
  const result = BigInt(value);
  if (result < 0n || result >= FIELD_MODULUS) throw new Error('Private field element out of range');
  return result;
}

export function loadPrivateParams(env: NodeJS.ProcessEnv): StrategyParams {
  if (!env.STRATEGY_PARAMS_JSON) throw new Error('STRATEGY_PARAMS_JSON is not configured');
  if (env.STRATEGY_PARAMS_JSON.length > 1024) throw new Error('Private parameters exceed size limit');
  let parsed: unknown;
  try { parsed = JSON.parse(env.STRATEGY_PARAMS_JSON); }
  catch { throw new Error('Private parameters are not valid JSON'); }
  if (!Array.isArray(parsed) || parsed.length !== 8) throw new Error('Private parameters must be an ordered eight-element array');
  const params = Object.freeze(parsed.map(fieldElement)) as StrategyParams;
  validateVfyParams(params);
  return params;
}
