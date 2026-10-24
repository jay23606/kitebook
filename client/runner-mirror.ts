// Runner code status and mirror: each checkout's git state for code_status, and the opt-in repos/<name>/ mirror of a checkout.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { Glob } from "bun";
import { io, ioStats, call, log, sh, cfg, me } from "./runner-ctx.ts";
import { originOf } from "./runner-git.ts";

// ---- sync status: each checkout's git state for code_status (fetch on a schedule; never touches a dirty or diverged checkout) ----
// autoFastForward (runner.json, global or per project, default off): fast-forward a CLEAN checkout that is only behind its upstream.
export const ASSISTANT_BRANCHES = () => (cfg.assistantBranches ?? ["hark/*", "claude/*", "chatgpt/*", "kitebook/*", "relay/*"]) as string[];
export async function gitState(proj: any) {
  const d = proj.path, remote = proj.remote ?? "origin", g = (a: string[]) => sh(["git", ...a], d);
  if (!d) return null;
  if (!existsSync(join(d, ".git"))) return existsSync(d) ? null : { missing: true, error: `the checkout is gone from ${d}` }; // preflight: a project whose folder was moved or deleted
  const branch = (await g(["rev-parse", "--abbrev-ref", "HEAD"])).out.trim() || null, head = (await g(["rev-parse", "HEAD"])).out.trim() || null;
  const dirty = (await g(["--no-optional-locks", "status", "--porcelain"])).out.split("\n").filter(Boolean).length;
  const up = await g(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]), upstream = up.code === 0 ? up.out.trim() : null;
  let ahead = 0, behind = 0;
  if (upstream) { const lr = (await g(["rev-list", "--left-right", "--count", `HEAD...${upstream}`])).out.trim().split(/\s+/).map(Number); ahead = lr[0] || 0; behind = lr[1] || 0; }
  const dh = (await g(["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`])).out.trim();
  const def = dh || ((await g(["rev-parse", "--verify", "-q", `${remote}/main`])).code === 0 ? `${remote}/main` : (await g(["rev-parse", "--verify", "-q", `${remote}/master`])).code === 0 ? `${remote}/master` : null);
  // ahead of the upstream, but every one of those commits is already on another branch of the remote (a checkout on main that pulled
  // origin dev): that is the dev channel, not unpushed work. contained_in names the branch (origin/dev first), codeNotes words it.
  let contained_in: string | null = null;
  if (upstream && ahead > 0 && head) { const devRef = `${remote}/dev`;
    if (devRef !== upstream && (await g(["rev-parse", "--verify", "-q", devRef])).code === 0 && (await g(["merge-base", "--is-ancestor", "HEAD", devRef])).code === 0) contained_in = devRef;
    else contained_in = (await g(["for-each-ref", "--count=1", "--contains", "HEAD", "--format=%(refname:short)", `refs/remotes/${remote}/`])).out.split("\n").filter(l => l && l !== `${remote}/HEAD` && l !== upstream)[0] ?? null; }
  const pats = ASSISTANT_BRANCHES().map(p => new Glob(p)), assistant: any[] = [];
  for (const r of (await g(["for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/`])).out.split("\n").filter(Boolean)) {
    const name = r.slice(remote.length + 1); if (name === "HEAD" || !pats.some(p => p.match(name))) continue;
    const notIn = def ? Number((await g(["rev-list", "--count", `${def}..${r}`])).out.trim()) || 0 : 0; if (def && !notIn) continue; // merged
    // already in what is checked out (HEAD) or its upstream (e.g. merged into dev while the default branch is main): nothing to pull
    if (head && !Number((await g(["rev-list", "--count", `HEAD..${r}`])).out.trim())) continue;
    if (upstream && !Number((await g(["rev-list", "--count", `${upstream}..${r}`])).out.trim())) continue;
    const local = (await g(["rev-parse", "--verify", "-q", `refs/heads/${name}`])).code === 0;
    const local_behind = local ? Number((await g(["rev-list", "--count", `${name}..${r}`])).out.trim()) || 0 : 0;
    assistant.push({ name, ahead: notIn, local, local_behind });
    if (assistant.length >= 50) break;
  }
  // merged_heads (C22 payoff, the Status week line): commits from the last 8 days that are in the default branch (remote or local),
  // so the server can count tasks whose head commit really got merged (also after the task branch was deleted). Squash/rebase merges
  // rewrite the commit, so they aren't seen: this undercounts, never invents.
  const merged = new Set<string>();
  for (const tgt of [...new Set([def, def?.slice(remote.length + 1), "main", "master"].filter(Boolean) as string[])]) {
    if ((await g(["rev-parse", "--verify", "-q", tgt])).code) continue;
    for (const sha of (await g(["rev-list", "--since=8.days.ago", "--max-count=300", tgt])).out.split("\n")) if (sha) merged.add(sha.slice(0, 12)); // 12-hex prefixes keep the code report small
  }
  let fast_forwarded = false;
  if ((proj.autoFastForward ?? cfg.autoFastForward) === true && upstream && !dirty && behind > 0 && ahead === 0 && (await g(["merge", "--ff-only", "-q", upstream])).code === 0) {
    fast_forwarded = true; behind = 0; // only ever a clean, strictly-behind checkout
  }
  return { branch, head, dirty, upstream, ahead, behind, ...(contained_in ? { contained_in } : {}), default_branch: def, assistant_branches: assistant, fetched_at: (proj as any)._fetchedAt ?? null, ...((proj as any)._fetchErr ? { fetch_error: (proj as any)._fetchErr } : {}), merged_heads: [...merged].slice(0, 300), ...(fast_forwarded ? { fast_forwarded } : {}) };
}
export let codeBusy = false;
export async function reportCode(fetch = false) {
  if (codeBusy) return; codeBusy = true;
  try {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries<any>(cfg.projects ?? {})) {
      if (fetch && v.path && existsSync(v.path) && (await originOf(v))) { const fr = await sh(["git", "fetch", "-q", "--prune", v.remote ?? "origin"], v.path); if (fr.code === 0) { v._fetchedAt = new Date().toISOString(); v._fetchErr = null; } else v._fetchErr = { at: new Date().toISOString(), error: String(fr.err || `exit ${fr.code}`).trim().split("\n").pop()!.slice(0, 200) }; } // preflight: the remote unreachable (src/health.ts)
      try { const st = await gitState(v); if (st) out[k] = st; } catch (e: any) { out[k] = { error: String(e.message).slice(0, 200) }; }
    }
    // unchanged state isn't re-sent every minute: only on a change, or every 10 min so code_status' reported_at stays recent
    const j = JSON.stringify(out), rc = reportCode as any; if (j === rc.last && Date.now() - rc.at < 10 * 60_000) { io.codeSkipped++; return; }
    await call("code_report", { projects: out }); rc.last = j; rc.at = Date.now(); io.codeReports++;
  } finally { codeBusy = false; }
}

// ---- mirror: repos/<name>/ in the space tracks this checkout; only changed files go up ----
export const DENY = [/(^|\/)\.env(\..*)?$/, /\.(pem|key|p12|pfx)$/, /(^|\/)id_(rsa|ed25519|ecdsa)/, /(^|\/)\.npmrc$/, /(^|\/)\.netrc$/, /(^|\/)\.git\//];
export const MAX_MIRROR_FILE = 20_000_000;
export async function sha256(buf: Uint8Array) { return new Bun.CryptoHasher("sha256").update(buf).digest("hex"); }
export const isText = (b: Uint8Array) => { if (b.includes(0)) return false; try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; } };
export async function mirror(name: string, proj: any) {
  const stateFile = join(homedir(), ".kitebook", `${me.name}.${cfg.space}.mirror.${name}.json`);
  const prev: Record<string, string> = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : {};
  const ls = await sh(["git", "ls-files", "-z", "-co", "--exclude-standard"], proj.path);
  if (ls.code) throw new Error("git ls-files: " + ls.err);
  const files = ls.out.split("\0").filter(f => f && !DENY.some(r => r.test(f)));
  const now: Record<string, string> = {}, bodies = new Map<string, Uint8Array>();
  // stat cache: a file whose size/mtime/ctime/inode match the last scan keeps its recorded hash and is not read (was: every file read
  // and sha256'd every mirrorEvery seconds). Anything that moved is read and hashed as before.
  const prevStat: Record<string, string> = JSON.parse(prev["\0stat"] ?? "{}"), stat: Record<string, string> = {}; io.mirrorScans++;
  for (const f of files) {
    const full = join(proj.path, f); let st; try { st = statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > MAX_MIRROR_FILE) continue;
    const sig = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`; stat[f] = sig;
    if (prevStat[f] === sig && prev[f]) { now[f] = prev[f]; continue; }
    const b = new Uint8Array(readFileSync(full)); io.mirrorReads++; const h = await sha256(b); now[f] = h; if (prev[f] !== h) bodies.set(f, b);
  }
  const head = (await sh(["git", "rev-parse", "HEAD"], proj.path)).out.trim(), branch = (await sh(["git", "rev-parse", "--abbrev-ref", "HEAD"], proj.path)).out.trim();
  const wasSkipped = new Set<string>(JSON.parse(prev["\0skipped"] ?? "[]"));
  const gone = Object.keys(prev).filter(f => !f.startsWith("\0") && !(f in now) && !wasSkipped.has(f));
  now["\0stat"] = JSON.stringify(stat);
  if (!bodies.size && !gone.length && prev["\0head"] === head) { // nothing to send; keep the stat cache current (a touched file is read once, not every scan)
    if (now["\0stat"] !== prev["\0stat"]) { now["\0skipped"] = prev["\0skipped"] ?? "[]"; now["\0head"] = head; writeFileSync(stateFile, JSON.stringify(now)); } return 0; }
  io.mirrorSent++;
  const changed = [...bodies.keys()];
  const missing = new Set<string>();
  for (let i = 0; i < changed.length; i += 5000) for (const m of (await call("has", { shas: changed.slice(i, i + 5000).map(f => now[f]) })).missing) missing.add(m);
  const entries: any[] = changed.map(f => {
    const path = `repos/${name}/${f}`, b = bodies.get(f)!;
    if (!missing.has(now[f])) return { path, sha: now[f] };
    return isText(b) ? { path, content: new TextDecoder().decode(b) } : { path, content_base64: Buffer.from(b).toString("base64") };
  });
  for (const f of gone) entries.push({ path: `repos/${name}/${f}`, delete: true });
  entries.push({ path: `repos/${name}/.relay-repo.json`, content: JSON.stringify({ project: name, branch, commit: head, mirrored_by: me.name, at: new Date().toISOString() }, null, 2) });
  const skipped: string[] = [];
  let batch: any[] = [], bytes = 0;
  const flush = async () => { if (!batch.length) return; const r = await call("batch", { changes: batch, skip_rejected: true, message: `mirror ${name} @ ${head.slice(0, 10)} (${batch.length} files)` }); for (const s of r.skipped ?? []) skipped.push(s.path); batch = []; bytes = 0; };
  for (const e of entries) { const n = (e.content ?? e.content_base64 ?? "").length; if (batch.length >= 200 || bytes + n > 8_000_000) await flush(); batch.push(e); bytes += n; }
  await flush();
  const stillSkipped = [...wasSkipped].filter(f => f in now && !bodies.has(f)).concat(skipped.map(p => p.slice(`repos/${name}/`.length)));
  now["\0skipped"] = JSON.stringify(stillSkipped); // remembered so unchanged refused files aren't retried every scan
  now["\0head"] = head; writeFileSync(stateFile, JSON.stringify(now));
  log(`mirrored ${name}: ${changed.length} changed, ${gone.length} removed, ${skipped.length} refused by secret guard`);
  return changed.length + gone.length;
}
export let mirroring = false;
export async function mirrorAll() { if (mirroring) return; mirroring = true;
  for (const [name, proj] of Object.entries<any>(cfg.projects ?? {})) if (proj.mirror) try { await mirror(name, proj); } catch (e: any) { log("mirror error", name, e.message); }
  mirroring = false; ioStats(); }
