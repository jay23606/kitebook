// Shared limits for failure-driven work. No implicit retries and no extra coordination service.
export type FailurePolicy = { maxFailures: number; maxAgeMs: number; baseMs: number; capMs: number };
export type FailureState = { failures: number; firstAt: number; nextAt: number; paused: boolean; reason: string };
export const RESOURCE = {
  requestMs: 30_000, storageMs: 15_000, webhookMs: 5_000,
  streamMs: 300_000, streamBytes: 256 * 1024, streamCloseMs: 1000,
  approval: { maxFailures: 5, maxAgeMs: 3600_000, baseMs: 30_000, capMs: 600_000 },
  alarm: { maxFailures: 5, maxAgeMs: 3600_000, baseMs: 30_000, capMs: 600_000 },
  webhook: { maxFailures: 8, maxAgeMs: 3600_000, baseMs: 2000, capMs: 600_000 },
  refs: { maxFailures: 8, maxAgeMs: 24 * 3600_000, baseMs: 60_000, capMs: 3600_000 },
  gc: { maxFailures: 8, maxAgeMs: 24 * 3600_000, baseMs: 60_000, capMs: 3600_000 },
} as const;
export function failureDecision(state: FailureState | null, policy: FailurePolicy, now = Date.now()) {
  if (!state) return { paused: false, waitMs: 0 };
  const invalid = !Number.isSafeInteger(state.failures) || state.failures < 0 || !Number.isFinite(state.firstAt) || !Number.isFinite(state.nextAt);
  return { paused: invalid || state.paused || state.failures >= policy.maxFailures || now - state.firstAt >= policy.maxAgeMs, waitMs: Math.max(0, state.nextAt - now) };
}
export function failedResource(state: FailureState | null, policy: FailurePolicy, reason: string, now = Date.now()): FailureState {
  const failures = (state?.failures ?? 0) + 1, firstAt = state?.firstAt ?? now;
  const next = { failures, firstAt, nextAt: now + Math.min(policy.capMs, policy.baseMs * 2 ** Math.min(failures - 1, 20)), paused: false, reason: reason.slice(0, 300) };
  next.paused = failureDecision(next, policy, now).paused; return next;
}
// The callback owns response consumption; keep the deadline alive until it has read or cancelled the body.
export async function resourceIO<T>(run: (signal: AbortSignal) => Promise<T>, ms: number = RESOURCE.requestMs, parent?: AbortSignal): Promise<T> {
  const ctl = new AbortController(), timeout = Number.isFinite(ms) && ms > 0 ? ms : RESOURCE.requestMs;
  const signal = parent ? AbortSignal.any([parent, ctl.signal]) : ctl.signal;
  const timer = setTimeout(() => ctl.abort(new Error("resource operation deadline exceeded")), timeout);
  let onAbort!: () => void;
  try {
    signal.throwIfAborted();
    const stopped = new Promise<never>((_, reject) => { onAbort = () => reject(signal.reason); signal.addEventListener("abort", onAbort, { once: true }); });
    const result = await Promise.race([run(signal), stopped]);
    if (result instanceof Response) { ctl.abort(); throw new Error("resourceIO must consume the response before returning"); }
    return result;
  } finally { clearTimeout(timer); if (onAbort) signal.removeEventListener("abort", onAbort); }
}
export async function resourceBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
      if (size > maxBytes) throw new Error("resource response exceeds byte limit"); parts.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; } return bytes;
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}
// Bound writes as well as time. A graceful close has a short deadline; a stalled reader is then errored, not left queued forever.
export function resourceStream(maxBytes: number, onEnd: () => void, closeMs: number = RESOURCE.streamCloseMs) {
  let controller!: TransformStreamDefaultController<Uint8Array>, pending = 0, closing = false, ended = false, timer: ReturnType<typeof setTimeout> | undefined;
  const stream = new TransformStream<Uint8Array, Uint8Array>({ start(c) { controller = c; } }), writer = stream.writable.getWriter();
  const finish = () => { if (ended) return; ended = true; if (timer) clearTimeout(timer); onEnd(); };
  const abort = (reason = "stream resource limit") => { if (ended) return; closing = true; try { controller.error(new Error(reason)); } finally { finish(); } };
  const write = (bytes: Uint8Array) => {
    if (closing || ended) return;
    if (pending + bytes.byteLength > maxBytes) { abort("slow stream reader exceeded buffer limit"); return; }
    pending += bytes.byteLength;
    writer.write(bytes).catch(() => {}).finally(() => { pending -= bytes.byteLength; });
  };
  const done = writer.closed.then(finish, finish);
  return { done, readable: stream.readable, write, abort, close(final?: Uint8Array) {
    if (closing || ended) return; if (final) write(final); if (closing || ended) return;
    closing = true; timer = setTimeout(() => abort("stream close deadline exceeded"), closeMs); writer.close().catch(() => {});
  } };
}
