// Move a Kitebook server's state from `cf dev` (Vite + miniflare, the old scripts/mac-host.sh server) to plain workerd (selfhost/config.capnp).
//   bun scripts/migrate-cfdev.ts <old cf dev state dir (has v3/do)> <new data dir>     run it with both servers stopped
// Durable Objects: miniflare runs workerd's own local-disk storage with the same unique keys (relay-Dir, relay-Space), so the SQLite files
// (with their -wal/-shm and the alarm metadata) are copied as they are. Big files: miniflare simulates R2 as a SQLite index (_mf_objects:
// key -> blob_id) plus blob files; workerd's disk store wants <sha256> files and refs/<sha>/<space key> markers (src/blobs.ts), so each object
// is copied under its key, and every blob's bytes are checked against its sha256 before it counts. The old folder is never changed.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { Database } from "bun:sqlite";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { createHash } from "crypto";

const [from, to] = process.argv.slice(2);
if (!from || !to) { console.error("usage: bun scripts/migrate-cfdev.ts <old cf dev state dir> <new data dir>"); process.exit(2); }
const v3 = join(from, "v3");
if (!existsSync(join(v3, "do"))) { console.error(`no cf dev state in ${from} (expected ${v3}/do)`); process.exit(2); }
const doDir = join(to, "do"), blobDir = join(to, "blobs");
if (existsSync(doDir) && readdirSync(doDir).length) { console.error(`${doDir} already has data; refusing to overwrite it`); process.exit(2); }
mkdirSync(doDir, { recursive: true, mode: 0o700 }); mkdirSync(blobDir, { recursive: true, mode: 0o700 });
let dos = 0, blobs = 0, refs = 0, bad = 0;
for (const ns of readdirSync(join(v3, "do"))) { // relay-Dir, relay-Space (and anything else miniflare kept there)
  cpSync(join(v3, "do", ns), join(doDir, ns), { recursive: true });
  dos += readdirSync(join(doDir, ns)).filter(f => f.endsWith(".sqlite") && f !== "metadata.sqlite").length;
}
const idx = join(v3, "r2", "miniflare-R2BucketObject");
if (existsSync(idx)) for (const f of readdirSync(idx).filter(f => f.endsWith(".sqlite") && f !== "metadata.sqlite")) {
  const db = new Database(join(idx, f), { readonly: true });
  let rows: { key: string; blob_id: string | null; size: number }[] = [];
  try { rows = db.query("select key, blob_id, size from _mf_objects").all() as any; } catch { continue; } finally { db.close(); }
  for (const r of rows) {
    const m = r.key.match(/^blobs\/([0-9a-f]{64})$/), ref = r.key.match(/^refs\/([0-9a-f]{64})\/([A-Za-z0-9._-]+)$/);
    if (ref) { mkdirSync(join(blobDir, "refs", ref[1]), { recursive: true }); writeFileSync(join(blobDir, "refs", ref[1], ref[2]), ""); refs++; continue; }
    if (!m || !r.blob_id) continue;
    const src = join(v3, "r2", "relay-blobs", "blobs", r.blob_id);
    if (!existsSync(src)) { console.error(`missing blob file for ${r.key}`); bad++; continue; }
    if (createHash("sha256").update(readFileSync(src)).digest("hex") !== m[1]) { console.error(`blob ${m[1]} doesn't match its sha256; skipped`); bad++; continue; }
    mkdirSync(dirname(join(blobDir, m[1])), { recursive: true }); copyFileSync(src, join(blobDir, m[1])); blobs++;
  }
}
console.log(JSON.stringify({ ok: bad === 0, durable_objects: dos, blobs, refs, bad, to }));
process.exit(bad ? 1 : 0);
