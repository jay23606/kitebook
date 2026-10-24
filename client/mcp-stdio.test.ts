import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

type Message = Record<string, any>;
async function withBridge(handler: (request: Request) => Response | Promise<Response>, run: (b: {
  send: (value: unknown) => void; raw: (line: string) => void; next: () => Promise<Message>; messages: Message[]; tokenFile: string;
}) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "kb-stdio-")), tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "synthetic-one\n", { mode: 0o600 });
  const server = Bun.serve({ port: 0, fetch: handler });
  // Credentials come only from the synthetic file, regardless of the developer's environment.
  const env = { ...process.env }; delete env.KITEBOOK_TOKEN; delete env.RELAY_TOKEN;
  const proc = Bun.spawn(["node", new URL("./mcp-stdio.mjs", import.meta.url).pathname, `http://127.0.0.1:${server.port}`, tokenFile], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const messages: Message[] = [], queue: Message[] = [], waiters: ((value: Message) => void)[] = [];
  const stderr = new Response(proc.stderr).text();
  const read = (async () => {
    const decoder = new TextDecoder(); let buffer = "";
    for await (const bytes of proc.stdout) {
      buffer += decoder.decode(bytes, { stream: true }); let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1); messages.push(message);
        const waiter = waiters.shift(); if (waiter) waiter(message); else queue.push(message);
      }
    }
  })();
  const raw = (line: string) => { proc.stdin.write(line + "\n"); proc.stdin.flush(); };
  const next = () => queue.length ? Promise.resolve(queue.shift()!) : new Promise<Message>((resolve, reject) => {
    const waiter = (value: Message) => { clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { const i = waiters.indexOf(waiter); if (i >= 0) waiters.splice(i, 1); reject(Error("bridge response deadline exceeded")); }, 2000);
    waiters.push(waiter);
  });
  try { await run({ send: value => raw(JSON.stringify(value)), raw, next, messages, tokenFile }); }
  finally { proc.kill(); await proc.exited; await read; await stderr; server.stop(true); rmSync(dir, { recursive: true, force: true }); }
}
const request = (id: number | string, method = "ping", params?: unknown) => ({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });

test("stdio request preserves method, parameters, string id and remote result", async () => {
  const seen: any[] = [];
  await withBridge(async req => {
    seen.push({ path: new URL(req.url).pathname, authorization: req.headers.get("authorization"), accept: req.headers.get("accept"), contentType: req.headers.get("content-type"), body: await req.json() });
    return Response.json({ jsonrpc: "2.0", id: "string-id", result: { content: [{ type: "text", text: "日本語\nsecond line" }], structuredContent: { value: 7 } } });
  }, async b => {
    const message = request("string-id", "tools/call", { name: "read", arguments: { path: "shared/日本語.txt" } });
    b.send(message); const response = await b.next();
    expect(response).toEqual({ jsonrpc: "2.0", id: "string-id", result: { content: [{ type: "text", text: "日本語\nsecond line" }], structuredContent: { value: 7 } } });
    expect(seen).toEqual([{ path: "/mcp", authorization: "Bearer synthetic-one", accept: "application/json", contentType: "application/json", body: message }]);
  });
});

test("notifications are forwarded without stdout replies, including failed notifications", async () => {
  const seen: Message[] = []; let arrived!: () => void;
  const notifications = new Promise<void>(resolve => { arrived = resolve; });
  await withBridge(async req => {
    const m: any = await req.json(); seen.push(m);
    if (m.id === undefined) { if (seen.filter(m => m.id === undefined).length === 2) arrived(); return new Response(null, { status: m.method === "notifications/initialized" ? 202 : 401 }); }
    await notifications; return Response.json({ jsonrpc: "2.0", id: m.id, result: { received: seen.length } });
  }, async b => {
    for (const method of ["notifications/initialized", "notifications/cancelled"]) b.send({ jsonrpc: "2.0", method });
    // The server sees both notifications before responding to this barrier request.
    b.send(request(0)); expect((await b.next()).id).toBe(0);
    b.send(request(1)); expect((await b.next()).id).toBe(1);
    expect(seen.filter(m => m.id === undefined).map(m => m.method).sort()).toEqual(["notifications/cancelled", "notifications/initialized"]);
    expect(b.messages.map(m => m.id)).toEqual([0, 1]);
  });
});

test("401 gives a recovery hint without leaking response data, then reads a rotated token", async () => {
  const auth: (string | null)[] = [];
  await withBridge(async req => {
    auth.push(req.headers.get("authorization")); const m: any = await req.json();
    return auth.length === 1 ? new Response("private upstream diagnostic synthetic-secret", { status: 401 }) : Response.json({ jsonrpc: "2.0", id: m.id, result: {} });
  }, async b => {
    b.send(request(1)); const failed = await b.next();
    expect(failed).toMatchObject({ jsonrpc: "2.0", id: 1, error: { code: -32001 } });
    expect(failed.error.message).toMatch(/reconnect|sign in|renew/i);
    expect(JSON.stringify(failed)).not.toMatch(/synthetic-secret|private upstream|synthetic-one/);
    writeFileSync(b.tokenFile, "synthetic-two\n"); b.send(request(2)); expect((await b.next()).result).toEqual({});
    expect(auth).toEqual(["Bearer synthetic-one", "Bearer synthetic-two"]);
  });
});

test("dropped connection after accepting a write is not replayed and the bridge recovers", async () => {
  const seen: Message[] = [];
  await withBridge(async req => {
    const m: any = await req.json(); seen.push(m);
    if (m.method === "tools/call") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",')); setTimeout(() => controller.error(Error("synthetic connection drop")), 5); } }));
    return Response.json({ jsonrpc: "2.0", id: m.id, result: {} });
  }, async b => {
    b.send(request(1, "tools/call", { name: "write", arguments: { path: "shared/file", content: "once" } }));
    expect(await b.next()).toMatchObject({ id: 1, error: { code: -32000, message: expect.stringContaining("before retrying writes") } });
    b.send(request(2)); expect((await b.next()).result).toEqual({});
    expect(seen.map(m => m.id)).toEqual([1, 2]);
  });
});

test("invalid input and unsupported batches return protocol errors without reaching HTTP", async () => {
  const seen: Message[] = [];
  await withBridge(async req => { const m: any = await req.json(); seen.push(m); return Response.json({ jsonrpc: "2.0", id: m.id, result: {} }); }, async b => {
    b.raw("{broken"); expect(await b.next()).toMatchObject({ id: null, error: { code: -32700 } });
    for (const value of [null, [], [request(1)], 7, { jsonrpc: "1.0", id: 2, method: "ping" }, { jsonrpc: "2.0", id: false, method: "ping" }]) {
      b.send(value); expect((await b.next()).error.code).toBe(-32600);
    }
    expect(seen).toHaveLength(0); b.send(request(3)); expect((await b.next()).id).toBe(3);
  });
}, 15000);

test("HTTP failures and mismatched response ids stay errors and are never retried", async () => {
  const seen: Message[] = [];
  await withBridge(async req => {
    const m: any = await req.json(); seen.push(m);
    if (m.id === 1) return new Response("private error", { status: 503 });
    if (m.id === 2) return Response.json({ jsonrpc: "2.0", id: "wrong", result: { secret: "private" } });
    return Response.json({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found", data: { name: "missing" } } });
  }, async b => {
    b.send(request(1)); expect(await b.next()).toMatchObject({ id: 1, error: { code: -32000, message: "kitebook HTTP 503" } });
    b.send(request(2)); const mismatch = await b.next(); expect(mismatch).toMatchObject({ id: 2, error: { code: -32000 } }); expect(JSON.stringify(mismatch)).not.toContain("private");
    b.send(request(3)); expect(await b.next()).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32601, message: "method not found", data: { name: "missing" } } });
    expect(seen.map(m => m.id)).toEqual([1, 2, 3]);
  });
});
