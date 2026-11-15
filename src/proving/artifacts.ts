import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Retrieved through HTTPS from the links published on /build; review changes explicitly.
const pinned = [
  ['wasm/vfy-policy.wasm', 'bc0998250d2baf75b89deef5306867ffa7085a08d4f7d2caf0dd63a060b134d2'],
  ['zkey/vfy-policy_final.zkey', 'f9666a1655279ef27f7fee6d535ac8aa9e39286ac40ff6279fea87c21ab6ce41'],
] as const;
export interface Artifacts { wasmPath: string; zkeyPath: string }
export async function verifyArtifacts(directory: string): Promise<Artifacts> {
  for (const [file, digest] of pinned) {
    const bytes = await readFile(resolve(directory, file));
    if (createHash('sha256').update(bytes).digest('hex') !== digest) throw new Error('Artifact checksum mismatch');
  }
  return { wasmPath: resolve(directory, pinned[0][0]), zkeyPath: resolve(directory, pinned[1][0]) };
}
