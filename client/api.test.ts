import { test, expect } from "bun:test";
import { apiCall, ApiError, type ApiConnection } from "./api.ts";

const connection = { url: "https://kitebook.example/u/fixture", token: "fixture-token", space: "main" };

test("API transport retains account path, authentication, workspace override and caller headers", async () => {
  let request: any;
  const result = await apiCall(connection, "read", { path: "shared/note.md", space: "work" }, {
    headers: { "x-client": "fixture" }, fetcher: async (url, init) => {
      request = { url, headers: init!.headers, method: init!.method, args: JSON.parse(String(init!.body)) };
      return Response.json({ ok: true, result: { content: "published note" } });
    },
  });
  expect(result).toEqual({ content: "published note" });
  expect(request).toEqual({ url: connection.url + "/v1/read", method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json", "x-client": "fixture" }, args: { space: "work", path: "shared/note.md" } });
  let body: any;
  await apiCall({ url: connection.url, token: connection.token }, "whoami", {}, { fetcher: async (_url, init) => { body = JSON.parse(String(init!.body)); return Response.json({ ok: true, result: {} }); } });
  expect(body).toEqual({});
});

test("API errors retain HTTP status for password presence challenges; denied writes are never replayed", async () => {
  let calls = 0, error: any;
  try { await apiCall(connection, "device_password", {}, { fetcher: async () => { calls++; return Response.json({ ok: false, error: "fresh presence required" }, { status: 428 }); } }); }
  catch (e) { error = e; }
  expect(error).toBeInstanceOf(ApiError); expect(error.status).toBe(428); expect(error.message).toBe("fresh presence required"); expect(calls).toBe(1);
});

test("an HTTP failure cannot be treated as success by a contradictory response envelope", async () => {
  await expect(apiCall(connection, "write", {}, { fetcher: async () => Response.json({ ok: true, result: "should not succeed" }, { status: 503 }) })).rejects.toMatchObject({ status: 503 });
  await expect(apiCall(connection, "write", {}, { fetcher: async () => Response.json({ ok: false, error: "write refused" }) })).rejects.toMatchObject({ status: 200, message: "write refused" });
});

test("proxy HTML or empty JSON bodies produce a bounded status error without echoing response contents", async () => {
  for (const response of [new Response("<html>private proxy response</html>", { status: 502 }), Response.json(null), new Response(null, { status: 204 })]) {
    let error: any; try { await apiCall(connection, "whoami", {}, { fetcher: async () => response }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ApiError); expect(error.status).toBe(response.status); expect(error.message).not.toContain("private proxy");
  }
});

test("a stalled API response body is aborted by the caller deadline without retrying the operation", async () => {
  let calls = 0, cancelled = false;
  const server = Bun.serve({ port: 0, fetch() { calls++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"ok":true,"result":')); }, cancel() { cancelled = true; } })); } });
  try {
    await expect(apiCall({ ...connection, url: server.url.origin }, "write", {}, { timeoutMs: 40 })).rejects.toThrow("deadline");
    await Bun.sleep(15); expect(calls).toBe(1); expect(cancelled).toBe(true);
  } finally { server.stop(true); }
});

test("caller cancellation prevents requests and connections do not share credentials or workspace state", async () => {
  const ctl = new AbortController(); ctl.abort(new Error("owner cancelled")); let calls = 0;
  const fetcher = async (_url: string, init?: RequestInit) => { calls++; return Response.json({ ok: true, result: { authorization: (init!.headers as any).authorization, args: JSON.parse(String(init!.body)) } }); };
  await expect(apiCall(connection, "read", {}, { signal: ctl.signal, fetcher })).rejects.toThrow("owner cancelled"); expect(calls).toBe(0);
  const other: ApiConnection = { url: connection.url, token: "other-fixture", space: "other" };
  const [a, b] = await Promise.all([apiCall(connection, "whoami", {}, { fetcher }), apiCall(other, "whoami", {}, { fetcher })]);
  expect(a).toEqual({ authorization: "Bearer fixture-token", args: { space: "main" } }); expect(b).toEqual({ authorization: "Bearer other-fixture", args: { space: "other" } });
});


test("runner API facade keeps its workspace, headers and operation/status diagnostics", async () => {
  const ctx = await import("./runner-ctx.ts"), previous = ctx.cfg, previousHeaders = { ...ctx.H }; let request: any;
  const server = Bun.serve({ port: 0, async fetch(req) { request = { authorization: req.headers.get("authorization"), args: await req.json() }; return Response.json({ ok: false, error: "fresh presence required" }, { status: 428 }); } });
  try {
    ctx.setCfg({ url: server.url.origin, token: "runner-fixture", space: "runner-workspace" }); ctx.setH();
    await expect(ctx.call("policy")).rejects.toThrow("policy: answered HTTP 428: fresh presence required");
    expect(request).toEqual({ authorization: "Bearer runner-fixture", args: { space: "runner-workspace" } });
  } finally { server.stop(true); ctx.setCfg(previous); for (const k of Object.keys(ctx.H)) delete ctx.H[k]; Object.assign(ctx.H, previousHeaders); }
});
