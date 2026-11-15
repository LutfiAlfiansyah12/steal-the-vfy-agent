declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<{
    (inputs: bigint[]): Uint8Array;
    F: { toString(value: Uint8Array): string };
  }>;
}
declare module 'snarkjs' {
  export const groth16: {
    fullProve(input: unknown, wasm: string, zkey: string, logger?: unknown, witnessOptions?: unknown, proverOptions?: unknown): Promise<{ proof: Record<string, unknown>; publicSignals: string[] }>;
    verify(vk: unknown, signals: readonly string[], proof: unknown): Promise<boolean>;
  };
  export const zKey: { exportVerificationKey(path: string): Promise<Record<string, unknown>> };
}
