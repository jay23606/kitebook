#!/usr/bin/env bun
// What's in the Worker bundle (after `cf build`): its size raw and gzipped, and the bytes per package / src file, attributed through the
// bundle's source map (each mapped span counts for the file it came from; unmapped = rolldown glue + the runner's client files, which
// start.ts embeds as text). Prints JSON with --json. Smoke uses it as a size budget.
//   bun scripts/bundle-size.ts [bundle.js] [--top 30] [--json] [--max-gzip-kb N]   (exit 1 when gzip is over N KB)
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2), opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const top = Number(opt("--top") ?? 30), max = opt("--max-gzip-kb"), asJson = args.includes("--json");
const file = args.find(a => !a.startsWith("--")) ?? ".cloudflare/output/v0/workers/default/bundle/index.js";
const code = readFileSync(file, "utf8"), map = JSON.parse(readFileSync(file + ".map", "utf8")) as { sources: string[]; mappings: string };

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", V: Record<string, number> = {};
[...B64].forEach((c, i) => V[c] = i);
const by: Record<string, number> = {}, add = (k: string, n: number) => { by[k] = (by[k] ?? 0) + n; };
const lines = code.split("\n"); let src = 0;
map.mappings.split(";").forEach((ln, li) => {
  const L = lines[li] ?? "", segs: [number, number][] = []; let col = 0;
  for (const s of ln.split(",")) { if (!s) continue; const v: number[] = []; let x = 0, sh = 0;
    for (const c of s) { const d = V[c]; x += (d & 31) << sh; if (d & 32) sh += 5; else { v.push(x & 1 ? -(x >> 1) : x >> 1); x = 0; sh = 0; } }
    col += v[0]; if (v.length > 1) src += v[1]; segs.push([col, v.length > 1 ? src : -1]); }
  if (!segs.length) return add("(unmapped)", Buffer.byteLength(L));
  if (segs[0][0] > 0) add("(unmapped)", Buffer.byteLength(L.slice(0, segs[0][0])));
  segs.forEach(([c, s], i) => add(s < 0 ? "(unmapped)" : map.sources[s], Buffer.byteLength(L.slice(c, i + 1 < segs.length ? segs[i + 1][0] : L.length))));
});
const pkg: Record<string, number> = {};
for (const [k, n] of Object.entries(by)) { const m = k.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/); const p = m ? m[1] : k.replace(/^(?:\.\.\/)*/, "").replace(/^.*?\b(src|client)\//, "$1/"); pkg[p] = (pkg[p] ?? 0) + n; }
const raw = Buffer.byteLength(code), gz = gzipSync(code, { level: 9 }).length, kb = (n: number) => Math.round(n / 102.4) / 10;
const rows = Object.entries(pkg).sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, n]) => ({ name: k, kb: kb(n) }));
if (asJson) console.log(JSON.stringify({ file, raw_kb: kb(raw), gzip_kb: kb(gz), top: rows }));
else { console.log(`${file}: ${kb(raw)} KB, ${kb(gz)} KB gzip`); for (const r of rows) console.log(String(r.kb).padStart(8), "KB ", r.name); }
if (max && gz / 1024 > Number(max)) { console.error(`bundle is ${kb(gz)} KB gzip, over the ${max} KB budget`); process.exit(1); }
