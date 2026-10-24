#!/usr/bin/env node
// stdio <-> remote /mcp. No write is automatically replayed: a timeout may mean it already committed.
// Usage: node mcp-stdio.mjs [url] [token-file], or KITEBOOK_URL + KITEBOOK_TOKEN / KITEBOOK_TOKEN_FILE.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
process.title = "Kitebook MCP";
for (const k of Object.keys(process.env)) if (k.startsWith("RELAY_") && process.env["KITEBOOK_" + k.slice(6)] === undefined) process.env["KITEBOOK_" + k.slice(6)] = process.env[k];
const url = (process.argv[2] ?? process.env.KITEBOOK_URL).replace(/\/$/, "") + "/mcp";
// Read token files per request so rotation doesn't require a bridge restart. Never emit credentials or raw remote errors.
const token = () => (process.env.KITEBOOK_TOKEN ?? readFileSync(process.argv[3] ?? process.env.KITEBOOK_TOKEN_FILE, "utf8")).trim();
const emit = m => process.stdout.write(JSON.stringify(m) + "\n");
const hash = s => createHash("sha256").update(s).digest("hex");
const canonical = v => JSON.stringify(v, (_k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x);
const revisions = {}; let lastCheck = 0, checking, notified = "", active = 0;
async function remote(msg, ms = 130000) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${token()}` }, body: JSON.stringify(msg), signal: AbortSignal.timeout(ms) });
  if (r.status === 202) return null;
  if (!r.ok) { await r.body?.cancel(); throw new Error(`kitebook HTTP ${r.status}`); }
  // Responses can contain file data, but an unbounded stream must not exhaust a sandbox.
  const reader = r.body.getReader(), parts = []; let bytes = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength;
    if (bytes > 32 * 1024 * 1024) { await reader.cancel(); throw new Error("kitebook response exceeds bridge limit"); } parts.push(value); }
  return JSON.parse(Buffer.concat(parts).toString("utf8"));
}
async function check() {
  if (!revisions.known_tool_revision || !revisions.known_instructions_revision || Date.now() - lastCheck < 60000) return;
  if (checking) return checking;
  lastCheck = Date.now(); // failures share the same cooldown; idle bridges do no polling
  checking = (async () => {
    const r = await remote({ jsonrpc: "2.0", id: "kitebook-bridge-status", method: "tools/call", params: { name: "mcp_status", arguments: revisions } }, 10000);
    const st = r?.result?.structuredContent ?? JSON.parse(r?.result?.content?.find(c => c.type === "text")?.text ?? "null");
    if (!st?.tool_revision || !st?.instructions_revision) return;
    const key = st.tool_revision + ":" + st.instructions_revision;
    if (st.tool_revision !== revisions.known_tool_revision && notified !== key) emit({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    notified = key;
    // Instructions are applied only by initialize. Inform the host; don't silently mark them current.
    return st.instructions_revision !== revisions.known_instructions_revision ? { instructions_changed: true, next: "Reconnect Kitebook to apply its current server instructions." } : undefined;
  })().catch(() => undefined).finally(() => { checking = undefined; });
  return checking;
}
const rl = createInterface({ input: process.stdin });
rl.on("line", async line => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid JSON" } }); return; }
  const id = msg?.id;
  const fail = (code, message) => { if (id !== undefined) emit({ jsonrpc: "2.0", id, error: { code, message } }); };
  const validId = typeof id === "string" || typeof id === "number" && Number.isFinite(id);
  // Invalid envelopes aren't notifications: answer with null when there is no usable request id.
  if (!msg || Array.isArray(msg) || msg.jsonrpc !== "2.0" || typeof msg.method !== "string" || id !== undefined && !validId) {
    emit({ jsonrpc: "2.0", id: validId ? id : null, error: { code: -32600, message: "expected one JSON-RPC 2.0 request or notification" } }); return;
  }
  if (active >= 16 || Buffer.byteLength(line) > 8 * 1024 * 1024) { fail(-32000, "kitebook bridge capacity exceeded; retry later"); return; }
  active++;
  try {
    const update = msg.method === "tools/call" && msg.params?.name !== "mcp_status" ? await check() : undefined;
    const r = await remote(msg); if (id === undefined) return;
    if (!r || r.id !== id) throw new Error("invalid kitebook response");
    if (r.result && (msg.method === "initialize" || msg.method === "server/discover")) {
      if (r.result.serverInfo) { r.result.serverInfo.name = "Kitebook"; r.result.serverInfo.title ||= process.env.KITEBOOK_TITLE || "Kitebook"; }
      r.result.capabilities ??= {}; r.result.capabilities.tools = { ...r.result.capabilities.tools, listChanged: true };
      if (typeof r.result.instructions === "string") revisions.known_instructions_revision = hash(r.result.instructions);
      lastCheck = 0; notified = "";
    }
    if (msg.method === "tools/list" && Array.isArray(r.result?.tools)) revisions.known_tool_revision = hash(canonical(r.result.tools));
    if (update && r.result) { r.result._meta = { ...r.result._meta, "kitebook/mcpUpdate": update };
      if (Array.isArray(r.result.content)) r.result.content.push({ type: "text", text: update.next }); }
    emit(r);
  } catch (e) { const unauthorized = /HTTP 401\b/.test(e.message);
    fail(unauthorized ? -32001 : -32000, unauthorized ? "kitebook HTTP 401: reconnect Kitebook or renew its token, then retry" : /HTTP \d+$|exceeds bridge limit/.test(e.message) ? e.message : "kitebook request failed or timed out; check connectivity before retrying writes"); }
  finally { active--; }
});
