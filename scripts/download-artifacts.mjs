import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  ['wasm/vfy-policy.wasm', 'https://agentgames.zkverify.io/circuits/vfy-policy.wasm', [0, 97, 115, 109]],
  ['zkey/vfy-policy_final.zkey', 'https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey', [122, 107, 101, 121]],
];
function validateArtifact(bytes, relativePath, magic) {
  if (!magic.every((value, index) => bytes[index] === value)) throw new Error('Unexpected artifact format');
  if (relativePath.endsWith('.wasm')) {
    if (!WebAssembly.validate(bytes)) throw new Error('Invalid or truncated WASM');
  } else {
    if (bytes.length < 12) throw new Error('Truncated zkey header');
    let offset = 12;
    for (let section = 0; section < bytes.readUInt32LE(8); section++) {
      if (offset + 12 > bytes.length) throw new Error('Truncated zkey section header');
      const length = bytes.readBigUInt64LE(offset + 4);
      if (length > BigInt(bytes.length - offset - 12)) throw new Error('Truncated zkey section');
      offset += 12 + Number(length);
    }
    if (offset !== bytes.length) throw new Error('Invalid zkey length');
  }
}
const manifestPath = resolve(root, 'artifacts/manifest.json');
let manifest;
try { manifest = JSON.parse(await readFile(manifestPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

for (const [relativePath, url, magic] of targets) {
  const destination = resolve(root, 'artifacts', relativePath);
  const expected = manifest?.files.find((entry) => entry.path === relativePath);
  let bytes;
  try { bytes = await readFile(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Artifact download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 100_000_000) throw new Error('Artifact exceeds size limit');
    validateArtifact(bytes, relativePath, magic);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (expected && sha256 !== expected.sha256) throw new Error('Artifact checksum mismatch; review upstream changes');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
  }
  validateArtifact(bytes, relativePath, magic);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expected && sha256 !== expected.sha256) throw new Error('Existing artifact checksum mismatch');
  console.log(`${relativePath}: ${bytes.length} bytes; sha256 ${sha256}`);
  if (!manifest) manifest = { source: 'https://agentgames.zkverify.io/build', files: [] };
  if (!expected) manifest.files.push({ path: relativePath, url, sha256, bytes: bytes.length });
}
if (!(await readFile(manifestPath).catch(() => null))) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}
