#!/usr/bin/env bun
// A local stand-in for GitHub Releases, for the smoke (never the real api.github.com): bun scripts/fake-releases.ts <dir> <port>
//   <dir>/<tag>/<asset files>   one folder per release      <dir>/latest   the tag /releases/latest answers (stable)
// Answers the two API calls client/binary.ts makes (/repos/<o>/<r>/releases/latest and /releases/tags/<tag>) in GitHub's shape, and
// serves the assets at /download/<tag>/<file> (browser_download_url). Re-reads <dir> on every request, so a test can publish by copying files.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join } from "path";
const [dir, port] = process.argv.slice(2); if (!dir || !port) { console.error("usage: fake-releases.ts <dir> <port>"); process.exit(2); }
const base = `http://127.0.0.1:${port}`;
const rel = (tag: string) => { const d = join(dir, tag); if (!/^[\w.-]+$/.test(tag) || !existsSync(d) || !statSync(d).isDirectory()) return null;
  return { tag_name: tag, prerelease: tag === "dev", html_url: `${base}/notes/${tag}`, assets: readdirSync(d).sort().map(n => ({ name: n, browser_download_url: `${base}/download/${tag}/${n}` })) }; };
Bun.serve({ hostname: "127.0.0.1", port: Number(port), fetch(req) {
  const p = new URL(req.url).pathname; let m;
  if ((m = p.match(/^\/repos\/[\w.-]+\/[\w.-]+\/releases\/latest$/))) { const t = existsSync(join(dir, "latest")) ? readFileSync(join(dir, "latest"), "utf8").trim() : ""; const r = t && rel(t); return r ? Response.json(r) : new Response("not found", { status: 404 }); }
  if ((m = p.match(/^\/repos\/[\w.-]+\/[\w.-]+\/releases\/tags\/([\w.-]+)$/))) { const r = rel(m[1]); return r ? Response.json(r) : new Response("not found", { status: 404 }); }
  if ((m = p.match(/^\/download\/([\w.-]+)\/([\w.-]+)$/)) && existsSync(join(dir, m[1], m[2]))) return new Response(Bun.file(join(dir, m[1], m[2])));
  return new Response("not found", { status: 404 });
} });
console.log(`fake releases on ${base} from ${dir}`);
