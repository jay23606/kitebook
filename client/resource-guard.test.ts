import { test, expect } from "bun:test";
import { RESOURCE, failedResource, failureDecision, resourceIO, resourceBytes, resourceStream, type FailureState } from "./resource-guard.ts";

test("failure budgets survive serialization, expire by age and fail closed on invalid state", () => {
  let state: FailureState | null = null, now = 1000;
  for (let n = 1; n <= 5; n++) { state = failedResource(state, RESOURCE.approval, "approval unavailable", now); state = JSON.parse(JSON.stringify(state));
    expect(state!.paused).toBe(n === 5); now = state!.nextAt; }
  expect(failureDecision(state, RESOURCE.approval, now).paused).toBe(true);
  const first = failedResource(null, RESOURCE.approval, "offline", 1000);
  expect(failureDecision(first, RESOURCE.approval, 1000 + RESOURCE.approval.maxAgeMs).paused).toBe(true);
  expect(failureDecision({ ...first, nextAt: NaN }, RESOURCE.approval).paused).toBe(true);
});

test("an HTTP body that never ends hits its deadline without replaying the request", async () => {
  let calls = 0, stopped = false;
  const server = Bun.serve({ port: 0, fetch() { calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); }, cancel() { stopped = true; } })); } });
  try {
    await expect(resourceIO(async signal => resourceBytes(await fetch(`http://127.0.0.1:${server.port}`, { signal }), 1024), 40)).rejects.toThrow("deadline");
    await Bun.sleep(10); expect(calls).toBe(1); expect(stopped).toBe(true);
  } finally { server.stop(true); }
});

test("response byte limits cancel oversized bodies", async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32)); }, cancel() { cancelled = true; } }));
  await expect(resourceBytes(response, 16)).rejects.toThrow("byte limit"); expect(cancelled).toBe(true);
});

test("a stalled stream retains its slot until the hard close deadline aborts it", async () => {
  let ends = 0; const body = resourceStream(64, () => ends++, 20), reader = body.readable.getReader();
  const closed = reader.closed.catch(() => {}); body.write(new Uint8Array([1])); body.close(new Uint8Array([2]));
  expect(ends).toBe(0); await closed; await body.done; expect(ends).toBe(1); await expect(reader.read()).rejects.toThrow("deadline");
  body.abort(); expect(ends).toBe(1);
});

test("healthy streams deliver the final frame; slow consumers cannot accumulate unbounded queued bytes", async () => {
  let ends = 0; const healthy = resourceStream(64, () => ends++, 50), reader = healthy.readable.getReader();
  healthy.write(new Uint8Array([1])); expect((await reader.read()).value).toEqual(new Uint8Array([1]));
  healthy.close(new Uint8Array([2])); expect((await reader.read()).value).toEqual(new Uint8Array([2])); expect((await reader.read()).done).toBe(true);
  await reader.closed; await healthy.done; expect(ends).toBe(1);
  const slow = resourceStream(16, () => ends++), blocked = slow.readable.getReader(); const closed = blocked.closed.catch(() => {});
  slow.write(new Uint8Array(17)); await expect(blocked.read()).rejects.toThrow("buffer limit"); await closed; await slow.done; expect(ends).toBe(2);
});


test("a response cannot escape its operation deadline without being consumed",async()=>{
  await expect(resourceIO(async()=>new Response("unconsumed"))).rejects.toThrow("must consume");
});
