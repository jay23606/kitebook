import { test, expect } from "bun:test";
import { intervalMs, singleFlight, reconnectDelay, requestSignal, publishChanged } from "./retry.ts";
import { isOffline } from "./outbox.ts";
test("invalid recurring intervals fall back and are bounded instead of becoming millisecond loops", () => {
  for (const v of [0, -1, NaN, Infinity, "bad", null]) expect(intervalMs(v, 30)).toBe(30000);
  expect(intervalMs(0.001, 30)).toBe(1000); expect(intervalMs(1e20, 30)).toBe(86400000);
});
test("overlapping failed ticks coalesce, clear their latch, and allow recovery", async () => {
  let n=0, release!:()=>void; const gate=new Promise<void>(r=>release=r);
  const run=singleFlight(async()=>{n++;if(n===1){await gate;throw Error("offline");}return n;});
  const a=run(),b=run(); expect(a).toBe(b); release(); await expect(a).rejects.toThrow("offline");
  expect(await run()).toBe(2);expect(n).toBe(2);
});
test("reconnects back off through flapping connections, with bounded jitter", () => {
  expect(reconnectDelay(0,1)).toBe(3000);expect(reconnectDelay(1,1)).toBe(6000);
  for(let i=0;i<1000;i++){expect(reconnectDelay(i,0)).toBeGreaterThanOrEqual(2250);expect(reconnectDelay(i,1)).toBeLessThanOrEqual(60000);}
});
test("runner requests retain caller cancellation and have an independent deadline", async () => {
  const c=new AbortController(), s=requestSignal(c.signal,10);c.abort();expect(s.aborted).toBe(true);
  const d=requestSignal(undefined,10);await new Promise(r=>setTimeout(r,30));expect(d.aborted).toBe(true);
});
test("temporary failures keep durable notes retryable; permission and validation refusals do not", () => {
  for(const m of ["kb_list: answered HTTP 429","kb_add: rate limited","answered HTTP 503","fetch failed","The operation timed out"]) expect(isOffline(Error(m))).toBe(true);
  for(const m of ["answered HTTP 403","denied","invalid kind"])expect(isOffline(Error(m))).toBe(false);
});

test("failed capability publication does not poison the unchanged-content cache",async()=>{
  const cache:{last?:string}={};let n=0;const send=async()=>{if(++n===1)throw Error("connection reset");};
  await expect(publishChanged(cache,"same capabilities",send)).rejects.toThrow("connection reset");expect(cache.last).toBeUndefined();
  await publishChanged(cache,"same capabilities",send);await publishChanged(cache,"same capabilities",send);expect(n).toBe(2);expect(cache.last).toBe("same capabilities");
});
