// Real HTTP/SQLite/blob recovery checks, invoked by the existing smoke core (no new smoke section/check).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { pull, publish } from "../client/workspace.ts";
const base = process.env.KITEBOOK_URL!, adminToken = process.env.KITEBOOK_ADMIN_TOKEN!;
if (!base || !["localhost", "127.0.0.1"].includes(new URL(base).hostname) || !adminToken) throw Error("workspace-check requires an isolated local smoke server");
if (process.argv.includes("--resume")) {
  const saved = JSON.parse(readFileSync(process.env.KITEBOOK_RECOVERY_STATE!, "utf8"));
  const call = (op: string, args: any) => post("/v1/" + op, saved.token, { ...args, space: saved.space });
  const dir = mkdtempSync(join(tmpdir(), "sync-restart-"));
  try { await pull(call, dir, base + "#" + saved.space); assert.equal(readFileSync(join(dir, "files/shared/data.csv"), "utf8"), "updated by daily A\n");
    assert.equal((await call("sync", { cursor: saved.cursor })).reset_required, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log("published workspace and checkpoints survived a real server restart"); process.exit(0);
}
const id = "sync-" + crypto.randomUUID().slice(0, 8), root = mkdtempSync(join(tmpdir(), "sync-http-"));
async function post(route: string, token: string, args: any) { const r = await fetch(base + route, { method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify(args) }); const j: any = await r.json(); if (!j.ok) throw Error(j.error); return j.result; }
const admin = (op: string, args: any) => post("/admin/" + op, adminToken, args);
try {
  await admin("space", { id, name: "Recovery test" }); const p = await admin("peer", { name: id, kind: "assistant" });
  const grant = (space: string, paths = ["shared/**", "kb/**", "context/**"]) => admin("grant", { peer: id, space, verbs: ["read", "write", "delete"], paths });
  await grant(id); const call = (op: string, args: any) => post("/v1/" + op, p.token, { ...args, space: id });
  const binary = Buffer.alloc(300000, 255), h = createHash("sha256").update(binary).digest("hex");
  const payload = { operation_id: "first-publication", changes: [{ path: "shared/data.csv", content: "name,value\na,2\n", if_match: "none" }, { path: "shared/artifact.bin", content_base64: binary.toString("base64"), if_match: "none" }, { path: "kb/global/test.md", content: "A durable recovery finding", if_match: "none" }] };
  const written = await call("sync_publish", payload); const duplicate = await call("sync_publish", payload); assert.equal(duplicate.commit, written.commit);
  await assert.rejects(call("sync_publish", { ...payload, changes: [{ ...payload.changes[0], content: "different" }] }), /operation_id/);
  const toDelete = await call("sync_publish", { operation_id: "create-deletion-fixture", changes: [{ path: "shared/delete.txt", content: "temporary", if_match: "none" }] });
  const deletion = { operation_id: "delete-once", changes: [{ path: "shared/delete.txt", delete: true, if_match: toDelete.shas["shared/delete.txt"] }] };
  assert.equal((await call("sync_publish", deletion)).commit, (await call("sync_publish", deletion)).commit);
  const before = await call("sync", { path: "shared", limit: 1 });
  await call("sync_publish", { operation_id: "concurrent", changes: [{ path: "shared/data.csv", content: "name,value\na,3\n", if_match: written.shas["shared/data.csv"] }] });
  let snapshot = before; const names = [...before.entries.map((x: any) => x.path)]; while (snapshot.more) { snapshot = await call("sync", { cursor: snapshot.cursor, limit: 1 }); names.push(...snapshot.entries.map((x: any) => x.path)); }
  assert.deepEqual(names.sort(), ["shared/artifact.bin", "shared/data.csv"]);
  assert.match((await call("sync_read", { cursor: snapshot.read_cursor, path: "shared/data.csv" })).content, /a,2/);
  await assert.rejects(call("sync_publish", { operation_id: "stale-worker", changes: [{ path: "shared/data.csv", content: "stale", if_match: written.shas["shared/data.csv"] }, { path: "shared/partial.txt", content: "must not land", if_match: "none" }] }), /conflict/);
  await assert.rejects(call("stat", { path: "shared/partial.txt" }), /not found/);
  // Lost response: state retains the same operation id across retries, even if the user edits again meanwhile.
  const a = join(root, "dailyA"), b = join(root, "dailyB"); await pull(call, a, base + "#" + id); await pull(call, b, base + "#" + id);
  assert.equal(createHash("sha256").update(readFileSync(join(b, "files/shared/artifact.bin"))).digest("hex"), h);
  writeFileSync(join(a, "files/shared/data.csv"), "updated by daily A\n"); let lose = true;
  await assert.rejects(publish(async (op, args) => { const r = await call(op, args); if (op === "sync_publish" && lose) { lose = false; throw Error("lost response"); } return r; }, a, base + "#" + id, { goal: "Process data", next: "Review totals" }), /lost response/);
  await publish(call, a, base + "#" + id); await pull(call, b, base + "#" + id);
  assert.equal(JSON.parse(readFileSync(join(b, "files/shared/handoff.json"), "utf8")).next, "Review totals");
  // Retention can erase every notification while the accepted file changes remain recoverable.
  await admin("prune", { space: id, older_than_sec: 0 }); await pull(call, b, base + "#" + id);
  rmSync(b, { recursive: true }); await pull(call, b, base + "#" + id); assert.equal(readFileSync(join(b, "files/shared/data.csv"), "utf8"), "updated by daily A\n");
  const denied = Buffer.from("password=Abc123!xyz").toString("base64"); await assert.rejects(call("sync_publish", { operation_id: "secret", changes: [{ path: "kb/global/secret.md", content_base64: denied, if_match: "none" }] }), /password|secret/);
  const narrowCursor = (await call("sync", { path: "shared" })).cursor; await grant(id, ["shared/handoff.json"]); assert.equal((await call("sync", { cursor: narrowCursor })).reset_required, true); await pull(call, b, base + "#" + id);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(b, "state.json"), "utf8")).files), ["shared/handoff.json"]);
  await grant(id);
  if (process.env.KITEBOOK_RECOVERY_STATE) {
    const checkpoint = await call("sync", { path: "shared" });
    writeFileSync(process.env.KITEBOOK_RECOVERY_STATE, JSON.stringify({ space: id, token: p.token, cursor: checkpoint.cursor }), { mode: 0o600 });
  }
  // Portable export includes external blob bytes; import invalidates old checkpoints and rebuilds the KB index.
  await grant(id); const dump = await admin("export", { space: id }), copy = id + "-copy"; await admin("space", { id: copy, name: "Recovered copy" }); await grant(copy);
  const copied = (op: string, args: any) => post("/v1/" + op, p.token, { ...args, space: copy }); const empty = await copied("sync", { path: "shared" });
  await admin("import", { space: copy, dump }); assert.equal((await copied("sync", { cursor: empty.cursor })).reset_required, true);
  assert.equal((await copied("read", { path: "shared/artifact.bin" })).content_base64, binary.toString("base64"));
  assert.equal((await copied("kb_search", { query: "durable recovery finding" })).results.length, 1);
  console.log("workspace recovery HTTP checks passed (conflicts, receipts, pruning, sandbox loss, permissions, external-blob backup/restore)");
} finally { rmSync(root, { recursive: true, force: true }); }
