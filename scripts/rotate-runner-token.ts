// Replace a runner's token on this machine's kitebook and write it into runner.json, without the token ever reaching a terminal, a log or argv
// (scripts/upgrade-mac-host.sh uses it after an old `cf dev` server may have served runner.json to anyone with the tunnel address).
//   bun scripts/rotate-runner-token.ts rotate <runner.json> <local Kitebook url> <server dir>   -> {"ok":true,"peer":"<name>","at":<epoch ms>}
//   bun scripts/rotate-runner-token.ts online <local Kitebook url> <server dir> <peer> <since ms> [seconds]   -> waits until that runner is
//                                                       online again after <since> (it reconnected with the new token)
// The admin key is ADMIN_TOKEN from <server dir>/.dev.vars, read here, never passed in. The peer is the one runner.json's current token
// belongs to (whoami), else runner.json "name", else the only runner the server has; with several and no way to tell, it refuses (names only).
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "fs";
import { join, dirname, basename } from "path";
import { stampOwnerEdit } from "../client/guard.ts";

const [cmd, ...a] = process.argv.slice(2);
const fail = (m: string): never => { console.log(JSON.stringify({ ok: false, error: m })); process.exit(1); };
const admin = (dir: string) => { try { return (readFileSync(join(dir, ".dev.vars"), "utf8").match(/^ADMIN_TOKEN=(.+)$/m) ?? [])[1]?.trim() || fail(`no ADMIN_TOKEN in ${dir}/.dev.vars`); } catch { return fail(`can't read ${dir}/.dev.vars`); } };
const post = async (url: string, path: string, body: any, auth: string) => {
  try { const r = await fetch(url.replace(/\/+$/, "") + path, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    return await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` })) as any; }
  catch (e: any) { return { ok: false, error: `can't reach ${url} (${e?.code ?? e?.message ?? e})` }; }
};
const runners = async (url: string, key: string): Promise<string[]> => { const l = await post(url, "/admin/list", {}, key);
  return [...new Set(((l.result?.peers ?? []) as any[]).filter(p => p.kind === "runner" && !p.revoked).map(p => String(p.name)))]; };

if (cmd === "rotate") {
  const [cfgPath, url, dir] = a; if (!cfgPath || !url || !dir) fail("usage: rotate <runner.json> <local Kitebook url> <server dir>");
  if (!existsSync(cfgPath)) fail(`no runner config at ${cfgPath}`);
  let cfg: any; try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch (e: any) { fail(`${cfgPath} isn't valid JSON (${e.message})`); }
  if (!cfg.token) fail(`${cfgPath} has no "token" (this runner signs in another way), so there is nothing to replace in it`);
  const key = admin(dir);
  let peer: string | undefined = (await post(url, "/v1/whoami", {}, cfg.token)).result?.name; // the token still works: its own peer
  if (!peer) { const rs = await runners(url, key);
    peer = cfg.name && rs.includes(cfg.name) ? cfg.name : rs.length === 1 ? rs[0] : fail(rs.length ? `the token in ${basename(cfgPath)} no longer works and the server has several runners (${rs.join(", ")}); set "name" in ${cfgPath} to the right one and run this again` : "the server has no runner to rotate"); }
  const r = await post(url, "/admin/rotate", { peer }, key);
  if (!r.ok || !r.result?.token) fail(`the server refused to rotate ${peer}: ${r.error ?? "no token in its answer"}`);
  cfg.token = r.result.token; // the old one stops working right now; the runner's open connection is closed ("Token rotated")
  const tmp = join(dirname(cfgPath), `.${basename(cfgPath)}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 }); chmodSync(tmp, 0o600); renameSync(tmp, cfgPath); chmodSync(cfgPath, 0o600);
  stampOwnerEdit(cfgPath); // the owner's own edit: a running task's protected-file check doesn't count it as tampering
  const w = await post(url, "/v1/whoami", {}, cfg.token); if (w.result?.name !== peer) fail(`rotated ${peer}, but the new token doesn't answer whoami (${w.error ?? "?"})`);
  console.log(JSON.stringify({ ok: true, peer, at: Date.now() })); // epoch ms (a client module dresses up toISOString for people)
} else if (cmd === "online") {
  const [url, dir, peer, since, sec = "90"] = a; if (!url || !dir || !peer || !since) fail("usage: online <local Kitebook url> <server dir> <peer> <since ms> [seconds]");
  // online = a live socket right now; rotating closed the old one ("Token rotated") and the restart killed its process, so a socket that's up
  // after <since> + a moment is the new one (last_seen is a display string, not a time to compare)
  const key = admin(dir), end = Date.now() + Number(sec) * 1000;
  await Bun.sleep(Math.max(0, (Number(since) || 0) + 2000 - Date.now()));
  let last: any = null;
  while (Date.now() < end) {
    const s = await post(url, "/admin/status", {}, key);
    const ps = ((s.result?.spaces ?? []) as any[]).flatMap(sp => (sp.peers ?? []) as any[]).filter(p => p.name === peer);
    last = ps[0] ?? null;
    if (ps.some(p => p.online)) { console.log(JSON.stringify({ ok: true, peer, online: true })); process.exit(0); }
    await Bun.sleep(2000);
  }
  console.log(JSON.stringify({ ok: false, peer, online: false, last_seen: last?.last_seen ?? null })); process.exit(1);
} else fail("usage: rotate <runner.json> <url> <server dir> | online <url> <server dir> <peer> <since ms> [seconds]");
