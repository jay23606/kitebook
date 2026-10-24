// Shared bounds for recurring runner work. A hung tick never queues another copy of itself.
export function intervalMs(value: unknown, fallback: number, minimum = 1): number {
  const n = Number(value); return Math.min(86400, Math.max(minimum, Number.isFinite(n) && n > 0 ? n : fallback)) * 1000;
}
export function singleFlight<A extends unknown[], R>(run: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let pending: Promise<R> | undefined;
  return (...args) => pending ??= Promise.resolve().then(() => run(...args)).finally(() => { pending = undefined; });
}
export function reconnectDelay(failures: number, random = Math.random()): number {
  const cap = Math.min(60000, 3000 * 2 ** Math.min(5, Math.max(0, failures)));
  return Math.round(cap * (0.75 + Math.max(0, Math.min(1, random)) * 0.25));
}
export const requestSignal = (signal?: AbortSignal, ms = 30000) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);

export async function publishChanged(cache: { last?: string }, value: string, publish: () => Promise<unknown>): Promise<void> {
  if (cache.last === value) return; await publish(); cache.last = value; // failed/ambiguous writes stay retryable
}
