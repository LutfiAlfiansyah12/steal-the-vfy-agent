export class TurnFailure extends Error {
  constructor(readonly code: 'DEADLINE' | 'UNAVAILABLE' | 'INVALID_PROOF' | 'CONFLICT' | 'STORAGE' | 'VERIFICATION' | 'OVERLOADED') {
    super(code);
    this.name = 'TurnFailure';
  }
}

/** Race as well as abort: a stalled dependency cannot block the signed HOLD response. */
export async function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>, deadline: number): Promise<T> {
  const controller = new AbortController();
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new TurnFailure('DEADLINE');
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TurnFailure('DEADLINE'));
      }, remaining);
      timer.unref();
    });
    return await Promise.race([Promise.resolve().then(() => work(controller.signal)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new TurnFailure('DEADLINE');
}
