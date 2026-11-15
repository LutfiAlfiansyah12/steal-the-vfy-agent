import { resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  hmacSecret: string;
  kurierApiKey: string;
  artifactDirectory: string;
  dataDirectory: string;
  maxTurnMs: number;
  responseReserveMs: number;
  maxAgeMs: number;
  clockSkewMs: number;
  maxConcurrentProofs: number;
  allowCompetition: boolean;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const hmacSecret = env.AGENT_GAMES_HMAC_SECRET;
  if (!hmacSecret || hmacSecret.length < 16) throw new Error('AGENT_GAMES_HMAC_SECRET must be configured');
  if (env.ZKVERIFY_NETWORK && env.ZKVERIFY_NETWORK !== 'volta') throw new Error('Only Volta testnet is enabled');
  const maxTurnMs = integer(env, 'MAX_TURN_MS', 25_000, 1000, 59_000);
  const responseReserveMs = integer(env, 'RESPONSE_RESERVE_MS', 1500, 100, maxTurnMs - 100);
  if (env.ALLOW_COMPETITION && !['true', 'false'].includes(env.ALLOW_COMPETITION)) throw new Error('Invalid ALLOW_COMPETITION');
  return Object.freeze({
    host: env.HOST ?? '127.0.0.1',
    port: integer(env, 'PORT', 3000, 1, 65535),
    hmacSecret,
    kurierApiKey: env.KURIER_API_KEY ?? '',
    artifactDirectory: resolve(env.ARTIFACT_DIRECTORY ?? 'artifacts'),
    dataDirectory: resolve(env.DATA_DIRECTORY ?? 'runtime'),
    maxTurnMs,
    responseReserveMs,
    maxAgeMs: 60_000,
    clockSkewMs: 5000,
    maxConcurrentProofs: integer(env, 'MAX_CONCURRENT_PROOFS', 1, 1, 8),
    allowCompetition: env.ALLOW_COMPETITION === 'true',
  });
}
