#!/usr/bin/env bun
// Small release contract check against the production bundle. Temporary data only; no real agents, accounts or cloud services.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pull } from "../client/workspace.ts";

const root = resolve(import.meta.dir, ".."), dir = mkdtempSync(join(tmpdir(), "kitebook-release-"));
const admin = crypto.randomUUID(), checks: string[] = [], children = new Set<ReturnType<typeof Bun.spawn>>();
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(KITEBOOK_|RELAY_)/.test(k)));
const env = { ...cleanEnv, HOME: dir, KITEBOOK_ADMIN_TOKEN: admin };
const ports = [Bun.serve({ port: 0, fetch: () => new Response() }), Bun.serve({ port: 0, fetch: () => new Response() })];
const [base, edge] = ports.map(s => `http://127.0.0.1:${s.port}`); ports.forEach(s => s.stop(true));
for (const name of ["do", "blobs"]) mkdirSync(join(dir, name));
let server: ReturnType<typeof Bun.spawn> | undefined, cookie = "";
const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); checks.push(label); console.log(`PASS ${label}`); };
const request = (path: string, body?: unknown, headers: Record<string, string> = {}, origin = base) => fetch(origin + path, {
  method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: "manual",
});
async function api(path: string, body?: unknown, headers: Record<string, string> = {}, origin = base): Promise<any> {
  const r = await request(path, body, headers, origin), j: any = await r.json();
  if (!r.ok || j.ok === false) throw Error(`${path}: HTTP ${r.status}: ${j.error ?? "request failed"}`); return j;
}
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const owner = () => ({ cookie, origin: base });
const call = async (token: string, op: string, args: any = {}) => (await api(`/v1/${op}`, args, bearer(token))).result;
async function stopServer() { if (server) { server.kill(); await server.exited; children.delete(server); server = undefined; } }
async function startServer() {
  const log = Bun.file(join(dir, "server.log"));
  server = Bun.spawn([join(root, "node_modules/.bin/workerd"), "serve", "selfhost/config.capnp", "--experimental",
    "--directory-path", `relay-do=${dir}/do`, "--directory-path", `relay-blobs=${dir}/blobs`,
    "--socket-addr", `http=${new URL(base).host}`, "--socket-addr", `edge=${new URL(edge).host}`], { cwd: root, env, stdout: log, stderr: log });
  children.add(server);
  for (let n = 0; n < 100; n++) { try { if ((await api("/health")).ok) return; } catch {} if (server.exitCode !== null) break; await Bun.sleep(100); }
  throw Error("production server did not start");
}
try {
  await startServer();
  check((await request("/admin/list", {}, {}, edge)).status === 404, "public listener hides administration");
  check((await request("/start", { op: "signin", admin_key: "wrong-fixture-key" })).status === 401, "incorrect owner credential is refused");
  const signed = await request("/start", { op: "signin", admin_key: admin });
  cookie = signed.headers.getSetCookie().map(c => c.split(";")[0]).join("; ");
  check(signed.ok && !!cookie && (await api("/start", { op: "status" }, owner())).ok, "owner sign-in creates a working session");
  check((await request("/start", { op: "mint", client: "hark" }, { ...owner(), origin: "https://evil.example" })).status === 403, "cross-site owner actions are refused");
  const pair = await api("/connect", { agent: "daily", name: "release-fixture" }, {}, edge);
  await api("/device", { op: "approve", user_code: pair.user_code }, owner());
  const tokenResponse = await fetch(pair.token_endpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: pair.grant_type, device_code: pair.device_code }) });
  const tokens: any = await tokenResponse.json(), token = tokens.access_token;
  const identity = await call(token, "whoami");
  check(tokenResponse.ok && identity.name, "daily assistant pairs and verifies identity");
  const initialized = await api("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "release-fixture", version: "1" } } }, bearer(token));
  const tools = await api("/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" }, bearer(token));
  check(initialized.result.serverInfo && ["kb_search", "sync", "sync_read", "sync_ack"].every(name => tools.result.tools.some((t: any) => t.name === name)), "MCP initializes and exposes shared-memory tools");
  const jar = join(dir, "owner.jar");
  writeFileSync(jar, cookie.split("; ").map(c => { const i = c.indexOf("="); return `${new URL(base).hostname}\tFALSE\t/\tFALSE\t0\t${c.slice(0,i)}\t${c.slice(i+1)}`; }).join("\n"), { mode: 0o600 });
  const native = Bun.spawn([process.execPath, "scripts/ba-connect.ts", base, "root", jar, "register:ReleaseNative", "https://muse.example.test/callback", '{"choice":"read"}'], { cwd: root, env, stdout: "pipe", stderr: "pipe" }); children.add(native);
  const nativeOutput = await new Response(native.stdout).text(); await native.exited; children.delete(native);
  const oauth = JSON.parse(nativeOutput.trim().split("\n").at(-1)!);
  check(oauth.status === 200 && oauth.client_id && (await call(oauth.access_token, "whoami")).name, "native OAuth registration, PKCE and owner consent work");
  const refresh = await fetch(base + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }) });
  const renewed: any = await refresh.json();
  check(refresh.ok && renewed.refresh_token !== tokens.refresh_token && (await call(renewed.access_token, "whoami")).name === identity.name, "persisted daily credential refreshes and rotates");
  const active = renewed.access_token, operation = crypto.randomUUID();
  const publication = { operation_id: operation, changes: [{ path: "shared/release.txt", content: "shared fixture context", if_match: "none" }], message: "fixture handoff" };
  const first = await call(active, "sync_publish", publication), replay = await call(active, "sync_publish", publication);
  check(JSON.stringify(first) === JSON.stringify(replay), "uncertain publication can be retried without duplicate changes");
  const replica = join(dir, "replica"), remote = base + "/main", syncCall = (op: string, a: any) => call(active, op, a);
  await pull(syncCall, replica, remote, "shared");
  const file = join(replica, "files/shared/release.txt");
  check(readFileSync(file, "utf8") === "shared fixture context", "sync hydrates and acknowledges a shared handoff");
  rmSync(join(replica, "files"), { recursive: true });
  await pull(syncCall, replica, remote);
  check(readFileSync(file, "utf8") === "shared fixture context", "sandbox losing its files rehydrates instead of reusing a bare checkpoint");
  const runner = (await api("/admin/peer", { name: "fixture-runner", kind: "runner" }, bearer(admin))).result.token;
  await api("/admin/grant", { peer: "fixture-runner", space: "main", verbs: ["read", "write", "dispatch"], paths: ["**"] }, bearer(admin));
  const task = await call(active, "task_create", { target: "fixture-runner", title: "Fixture only", instructions: "No real agent runs" });
  const claimed = await call(runner, "task_claim", { id: task.id });
  check(claimed.state === "awaiting_approval" && !(await request("/v1/task_progress", { id: task.id, message: "unapproved" }, bearer(runner))).ok, "unapproved task cannot report execution");
  check(!(await request("/v1/task_approval", { id: task.id, decision: "approved" }, bearer(active))).ok, "assistant cannot approve its own work");
  await stopServer(); await startServer();
  check((await call(active, "read", { path: "shared/release.txt" })).content === "shared fixture context" && (await call(runner, "task_get", { id: task.id })).state === "awaiting_approval", "server restart retains context, credentials and pending approval");
  await api("/admin/resources", { action: "pause" }, bearer(admin)); await stopServer(); await startServer();
  const waiting = await call(active, "task_create", { target: "fixture-runner", title: "Paused fixture", instructions: "No real agent runs" });
  await api("/admin/space", { id: "paused-fixture" }, bearer(admin));
  const pausedStatus = await api("/admin/resources", { action: "status" }, bearer(admin));
  check(pausedStatus.result.spaces.every((s: any) => s.paused) && (await request("/admin/resources", { action: "resume" }, bearer(active))).status === 401 && (await request("/v1/task_claim", { id: waiting.id }, bearer(runner))).status === 423, "resource pause survives restart and blocks new background work");
  await api("/admin/resources", { action: "resume" }, bearer(admin));
  const resourceAudit = (await api("/admin/audit", { limit: 20 }, bearer(admin))).result.entries;
  check(resourceAudit.some((e: any) => e.action === "resources.pause") && resourceAudit.some((e: any) => e.action === "resources.resume") && !resourceAudit.some((e: any) => e.action === "resources.status") && (await call(runner, "task_claim", { id: waiting.id })).state === "awaiting_approval", "owner resource controls are audited and approval is still required");
  await api("/start", { op: "revoke", peer: identity.name }, owner());
  check((await request("/v1/whoami", {}, bearer(active))).status === 401 && (await call(runner, "task_get", { id: task.id })).state === "cancelled", "disconnect revokes cached credentials and cancels pending work");
  const deniedRefresh = await fetch(base + "/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: renewed.refresh_token }) });
  check(!deniedRefresh.ok, "disconnected credential cannot refresh back in");
  console.log(`ALL PASSED (${checks.length} release integration checks)`);
} catch (error) {
  console.error(error); try { console.error(readFileSync(join(dir, "server.log"), "utf8").slice(-5000)); } catch {} process.exitCode = 1;
} finally {
  for (const child of children) { child.kill(); await child.exited; }
  rmSync(dir, { recursive: true, force: true });
}
