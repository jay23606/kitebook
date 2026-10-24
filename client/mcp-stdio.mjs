#!/usr/bin/env node
// stdio <-> remote Kitebook /mcp bridge, for MCP clients that only speak stdio or can't attach headers.
// Usage: node mcp-stdio.mjs [url] [token-file]   or env KITEBOOK_URL + KITEBOOK_TOKEN / KITEBOOK_TOKEN_FILE
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
process.title = "Kitebook MCP";
for (const k of Object.keys(process.env)) if (k.startsWith("RELAY_") && process.env["KITEBOOK_" + k.slice(6)] === undefined) process.env["KITEBOOK_" + k.slice(6)] = process.env[k]; // RELAY_* from before the rename
// The connector's name is the product name, even if an older Kitebook answers initialize with something else.
const named = (m) => { const si = m?.result?.serverInfo; if (si) { si.name = "Kitebook"; si.title ||= process.env.KITEBOOK_TITLE || "Kitebook"; } return m; };
const url = (process.argv[2] ?? process.env.KITEBOOK_URL).replace(/\/$/, "") + "/mcp";
const token = (process.env.KITEBOOK_TOKEN ?? readFileSync(process.argv[3] ?? process.env.KITEBOOK_TOKEN_FILE, "utf8")).trim();
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  let id; try { id = JSON.parse(line).id; } catch {}
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: line });
    if (r.status === 202) return;
    const text = await r.text();
    let msg = null; try { msg = JSON.parse(text); } catch {}
    if (msg && (msg.jsonrpc || Array.isArray(msg))) return void process.stdout.write(JSON.stringify(Array.isArray(msg) ? msg.map(named) : named(msg)) + "\n");
    // HTTP-level error (bad token, 5xx): turn it into a JSON-RPC error so the MCP client doesn't hang
    if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: r.status === 401 ? -32001 : -32000, message: `kitebook HTTP ${r.status}: ${msg?.error ?? text.slice(0, 200)}` } }) + "\n");
  } catch (e) {
    if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: "kitebook unreachable: " + e.message } }) + "\n");
  }
});
