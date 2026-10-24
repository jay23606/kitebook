// Settings changes that live on this Mac (the runner side of /settings), so nobody pins a key by hand or edits runner.json:
//   - a browser signed in with this Mac's `kitebook open` link is trusted by itself: the link carries a one-time trust secret in its
//     #fragment (never sent to the server); the page registers its owner key with HMAC(secret, key), and only a browser that opened the
//     link can make it. A matching key is pinned in runner.json "ownerKeys" (15 minutes per link, once).
//   - every other change is an owner command (client/payload.ts) signed in a browser this Mac already trusts: trust / untrust a browser
//     key, approvals on the phone on/off, make (or replace) the release key. Checked here against the pinned keys, for this workspace,
//     at most a day old, done once (ids kept in ~/.kitebook/cmds-<name>.json), never on the server's word.
//   - Update now on a git checkout (do "update_ref" ref main, the stable channel, any owner) and Update to dev now (ref dev, Experimental only):
//     a fast-forward of the git checkout with no terminal y (updateRef below).
//   - Coding agents (do "connect_agent"): wire that agent on this Mac to Kitebook, same as `kitebook connect <agent>` (client/agents-connect.ts);
//     (do "default_agent"): which agent runs a project's tasks (runner.json prefs.byProject.<p>.agent) or this Mac's default (prefs.defaultAgent).
//   - Updates (client/updater.ts): Update now (do "update", the release the owner saw) and "Install signed updates automatically"
//     (do "auto_update" -> runner.json "autoUpdate"); an agent's relay_update ask (op policy's update_requests, no arguments) installs only
//     a newer release signed with the key this Mac pinned, otherwise it waits for the owner's click and Settings says who asked.
//     On a git install (Experimental on or off), an ask from one of the owner's own apps that may send tasks installs THE LATEST with no
//     approval (owner, 2026-10-22 22:00: "update is fine, just remove those barriers except it could only pull from latest"): this runner
//     itself (no task, no agent), once idle, fast-forwards the checkout to the newest commit of its channel, resolved again right before the
//     move, as the owner's Settings click does (git-channel.ts devUpdate: health check, roll back on failure). Which commit: origin/dev with
//     Experimental on (the owner-signed policy verified here), else the branch the checkout tracks (its upstream, usually main). The report says
//     update.nogate, so the server tells the app "updating" (a runner without it, 374169f, still gets the old waiting_approval answer).
//     The owner's kill switch (Settings -> Updates "Let apps update Kitebook") is on the server: off, it hands this Mac no asks.
// What was done (and the phone's ntfy name, the release key's public half, the Updates state) goes back with op settings_report, which only the owner's
// Settings page shows. Polls op policy every KITEBOOK_SETTINGS_POLL_MS (default 15 s; every second for a few minutes after kitebook open).
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { createHmac, createPublicKey, verify as cverify, randomBytes, timingSafeEqual } from "crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { cmdMsg, cmdShape, CMD_WINDOW_MS } from "./payload.ts";
import { fingerprint, validOwnerKey, verifyEnvelope } from "./policy.ts";
import { experimentalOn, UPDATE_REFS } from "./payload.ts";
import * as I from "./integrity.ts";
import * as U from "./updater.ts";
import * as G from "./git-channel.ts";
import { rmSync } from "fs";

const trusts = new Map<string, number>(); // trust secret -> until
let burstUntil = 0;
export function newTrust(ttl = 15 * 60_000) { const t = randomBytes(24).toString("base64url"); trusts.set(t, Date.now() + ttl); burstUntil = Date.now() + ttl; return t; }
export const proofOf = (secret: string, key: string) => createHmac("sha256", secret).update("relay-trust:v1|" + key).digest("base64url"); // = policy-ui.ts hmac
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
export function verifyCmd(env: any, pinned: string[], space: string, now = Date.now()): { cmd: any } | { error: string } {
  const e = cmdShape(env?.cmd); if (e) return { error: e };
  if (env.cmd.space !== space) return { error: `for workspace ${env.cmd.space}, this Mac is in ${space}` };
  if (Math.abs(now - env.cmd.at) > CMD_WINDOW_MS) return { error: "older than a day" };
  if (!pinned.includes(env.key)) return { error: `sent from a browser this Mac doesn't trust (${fingerprint(String(env.key))}); press Trust for it in a browser it trusts` };
  let ok = false; try { ok = cverify("sha256", Buffer.from(cmdMsg(env.cmd)), { key: createPublicKey({ key: Buffer.from(String(env.key).slice(5), "base64url"), format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" }, Buffer.from(String(env.sig), "base64url")); } catch {}
  return ok ? { cmd: env.cmd } : { error: "bad signature (changed after it was signed)" };
}
type Ctx = { experimental?: (x: { ci: boolean; gh_status: boolean } | null) => void; agentNames?: () => string[]; onChange?: () => void; cfgPath: string; name: string; space: string; call: (op: string, a?: any) => Promise<any>; log: (...a: any[]) => void; audit: (e: any) => void; stamp: (f: string) => void; darwin?: boolean; releaseKey?: () => string | null; makeReleaseKey?: (rotate: boolean) => string; installed?: (o: U.Outcome) => void; idle?: () => boolean };
const pendFile = (name: string) => join(homedir(), ".kitebook", `update-asks-${name}.json`); // asks that wait for the owner's click
// an app's update ask on a git install: kind "dev" (its first name), waiting only for the runner to be idle
type DevAsk = { kind: "dev"; id: string; by: string; at: string; sha: string; from: string; ref: string; why: string; approved?: { at: string; by: string }; code?: string; expires?: number };
const isDev = (q: any): q is DevAsk => q?.kind === "dev" && /^ur_[0-9a-f]{16}$/.test(String(q.id)) && /^[0-9a-f]{40}$/.test(String(q.sha));
// From before no-gate (374169f): "trust" asks (turning on Install updates without asking me) are dropped; a dev ask still waiting for its
// kitebook confirm code becomes an app's ask like any other (it installs the latest once idle, never the sha it once proposed). The saved
// standing approval and signed approvals left in ~/.kitebook are removed once (they no longer mean anything).
let migrated = false;
const loadPend = (name: string): any[] => { let l: any[] = []; try { l = JSON.parse(readFileSync(pendFile(name), "utf8")); } catch {}
  if (!migrated) { migrated = true; for (const f of [join(homedir(), ".kitebook", `update-trust-${name}.json`), join(homedir(), ".kitebook", "update-approvals")]) try { rmSync(f, { recursive: true, force: true }); } catch {} }
  return (Array.isArray(l) ? l : []).filter(q => q?.kind !== "trust"); };
const doneFile = (name: string) => join(homedir(), ".kitebook", `cmds-${name}.json`);
const savePend = (name: string, l: any[]) => { const f = pendFile(name); if (!l.length && !existsSync(f)) return; mkdirSync(dirname(f), { recursive: true, mode: 0o700 }); writeFileSync(f, JSON.stringify(l), { mode: 0o600 }); };
const loadDone = (name: string): any[] => { try { return JSON.parse(readFileSync(doneFile(name), "utf8")); } catch { return []; } };
let lastReport = "";
// one pass: read what the owner asked for, do what checks out, report back. Returns what changed in runner.json (for the log/tests).
export async function syncOnce(x: Ctx): Promise<string[]> {
  const r = await x.call("policy", {}), changed: string[] = [];
  const c = JSON.parse(readFileSync(x.cfgPath, "utf8")); c.ownerKeys = Array.isArray(c.ownerKeys) ? c.ownerKeys.map(String) : [];
  if (x.experimental) { const v = verifyEnvelope(r.envelope, c.ownerKeys, x.space); x.experimental("error" in v ? null : experimentalOn(v.policy)); } // Experimental's features (recent logs: client/devlog.ts; local CI: client/ci.ts) follow the owner-signed switch
  const darwin = x.darwin ?? (await import("./platform.ts")).dialogKind() !== null; // a desktop dialog here (macOS, a Linux desktop, Windows)
  // 1. kitebook open browsers prove the link's trust secret
  for (const k of r.owner_keys ?? []) { if (!k?.proof || c.ownerKeys.includes(k.key) || !validOwnerKey(k.key)) continue;
    for (const [t, until] of trusts) { if (until < Date.now()) { trusts.delete(t); continue; }
      if (same(proofOf(t, k.key), String(k.proof))) { c.ownerKeys.push(k.key); trusts.delete(t); changed.push(`trusted ${k.label ?? "a browser"} (${fingerprint(k.key)}), signed in with kitebook open`); x.audit({ type: "owner_key_trusted", fp: fingerprint(k.key), how: "kitebook open" }); break; } } }
  // 2. owner commands signed by a browser this Mac trusts
  let inst: U.Outcome | null = null; // an install restarts the runner: only after what was done is saved and reported
  const done = loadDone(x.name), seen = new Set(done.map((d: any) => d.id)), fresh: any[] = [];
  for (const env of r.cmds ?? []) { const id = String(env?.cmd?.id ?? ""); if (!id || seen.has(id)) continue;
    if (env.cmd.runner != null && env.cmd.runner !== x.name) continue; // for another Mac
    const v = verifyCmd(env, c.ownerKeys, x.space); let ok = false, msg = "";
    if ("error" in v) msg = v.error;
    else { const m = v.cmd;
      try {
        if (m.do === "trust") { if (!validOwnerKey(m.key)) throw new Error("not a browser key"); if (!c.ownerKeys.includes(m.key)) c.ownerKeys.push(m.key); msg = `trusts ${fingerprint(m.key)} now`; }
        else if (m.do === "untrust") { if (m.key === env.key) throw new Error("a browser can't forget itself; forget it from another one");
          c.ownerKeys = c.ownerKeys.filter((k: string) => k !== m.key); msg = `forgot ${fingerprint(m.key)}`; }
        else if (m.do === "approvals") {
          if (c.approve === "auto") throw new Error("this Mac runs tasks without asking (zero-touch), so there is nothing to approve; turn that off on the Mac first");
          if (m.phone) { c.ntfy ??= {}; c.ntfy.topic ??= "kitebook-" + randomBytes(16).toString("hex"); c.ntfy.server ??= "https://ntfy.sh"; c.approve = darwin ? "dialog+phone" : "phone"; msg = "approvals also go to your phone"; }
          else if (!darwin) { c.approve = "browser"; msg = "approvals wait for you on /start (Status) and kitebook approve; no phone push"; }
          else { c.approve = "dialog"; msg = "approvals go to the Mac dialog (and kitebook approve)"; } }
        else if (m.do === "release_key") { if (!x.makeReleaseKey) throw new Error("this runner can't make release keys"); msg = `release key ${x.makeReleaseKey(!!m.rotate)}`; }
        else if (m.do === "auto_update") { c.autoUpdate = m.on; msg = m.on ? "installs signed updates by itself when it's idle" : "updates only when you press Update now"; await U.refresh(c); }
        else if (m.do === "update_ref") msg = await updateRef(c, r.envelope, x, String(m.ref));
        else if (m.do === "update_trust") msg = "Install updates without asking me is gone: your apps' updates install the latest by themselves now (Settings -> Updates -> Let apps update Kitebook turns that off)"; // an older Settings page
        else if (m.do === "connect_agent") { const C = await import("./agents-connect.ts"); if (!C.AGENTS[m.agent]) throw new Error(`Kitebook doesn't know how to connect ${m.agent}`);
          const res = await C.connect({ url: c.url, token: c.token, space: c.space }, [m.agent]); if (!res.ok.length) throw new Error(`${C.AGENTS[m.agent].label}: ${res.failed[0]?.why ?? "not connected"}`);
          msg = `${C.AGENTS[m.agent].label} MCP is configured; reload the agent to connect. It uses only its own folder (kb/${res.ok[0].peer}) and can't send tasks`; }
        else if (m.do === "default_agent") { const names = x.agentNames?.() ?? [], a = String(m.agent ?? "");
          if (a && !names.includes(a)) throw new Error(`${a} isn't an agent on this Mac (agents: ${names.join(", ")})`);
          c.prefs ??= {}; if (m.project == null) { if (a) c.prefs.defaultAgent = a; else delete c.prefs.defaultAgent; msg = a ? `${a} runs tasks on this Mac by default` : "back to this Mac's default agent"; }
          else { const bp = (c.prefs.byProject ??= {}), e = { ...(bp[m.project] ?? {}) }; if (a) e.agent = a; else delete e.agent;
            if (Object.keys(e).length) bp[m.project] = e; else delete bp[m.project]; msg = a ? `${a} runs ${m.project}'s tasks` : `${m.project} uses this Mac's default agent again`; } }
        else if (m.do === "update") { const o = await U.apply(c, { by: "you, in Settings", cfgPath: x.cfgPath, approved: m.version });
          x.audit({ type: "update", by: o.by, result: o.result, from: o.from, to: o.to, release: o.release, why: o.why }); await U.refresh(c);
          if (o.result === "refused" || o.result === "rolled back") throw new Error(o.why ?? o.result);
          msg = o.result === "up to date" ? "already up to date" : `updated to release ${o.release ?? o.to}; the runner restarts once its tasks finish`;
          if (o.result === "installed") { savePend(x.name, []); inst = o; } }
        ok = true; changed.push(`${m.do}: ${msg}`); x.audit({ type: "owner_cmd", do: m.do, id, by: fingerprint(env.key) });
      } catch (e: any) { msg = e.message; } }
    fresh.push({ id, do: String(env?.cmd?.do ?? "?"), ok, msg, at: new Date().toISOString() }); seen.add(id); if (!ok) x.log(`settings change ${id} not done: ${msg}`); }
  // 3. agents' relay_update asks: no arguments, so all they can ask for is the newest release signed with the key pinned here, or (a git
  // install, Experimental on or off) its channel's newest commit, installed once idle with no approval (devAsk, devPending)
  const pend = loadPend(x.name);
  for (const q of r.update_requests ?? []) { const id = String(q?.id ?? ""); if (!/^ur_[0-9a-f]{16}$/.test(id) || seen.has(id) || pend.some(p => p.id === id)) continue;
    const by = String(q.by ?? "an agent").slice(0, 40);
    if (G.gitMode(c)) { const d = await devAsk(c, r.envelope, x, q, by, id);
      if ("ask" in d) { pend.push(d.ask); continue; } // installed below once idle (devPending)
      seen.add(id); fresh.push(d.done); if (d.owner) pend.push({ id, by, at: new Date().toISOString(), why: d.why }); continue; }
    seen.add(id);
    const o = await U.apply(c, { by: `${by} (relay_update)`, cfgPath: x.cfgPath }); await U.refresh(c);
    const owner = o.result === "refused" && ["no_key", "no_number"].includes(U.lastCheck()?.state ?? "");
    if (owner) pend.push({ id, by, at: new Date().toISOString(), why: o.why }); if (o.result === "installed") pend.length = 0;
    const msg = o.result === "installed" ? `${by} asked; updated to release ${o.release ?? o.to}` : o.result === "up to date" ? `${by} asked; already up to date` : owner ? `${by} asked; waits for you: ${o.why}` : `${by} asked; not updated: ${o.why}`;
    fresh.push({ id, do: "relay_update", ok: o.result === "installed" || o.result === "up to date", msg, at: new Date().toISOString() }); x.log(`update asked by ${by}: ${o.result}${o.why ? ": " + o.why : ""}`);
    x.audit({ type: "update", by: o.by, result: o.result, from: o.from, to: o.to, release: o.release, why: o.why }); if (o.result === "installed") inst = o; }
  for (const q of pend.filter(isDev)) { const d = await devPending(c, r.envelope, x, q); if (!d) continue; // still waiting for the runner to be idle
    pend.splice(pend.indexOf(q), 1); seen.add(q.id); fresh.push(d); if (d.state === "updated") for (const o of pend.filter(p => !isDev(p))) pend.splice(pend.indexOf(o), 1); }
  savePend(x.name, pend.slice(-10));
  if (changed.length) { writeFileSync(x.cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 }); x.stamp(x.cfgPath); for (const l of changed) x.log("settings: " + l); x.onChange?.(); } // re-advertise: Settings shows which browsers this Mac trusts
  const all = [...done, ...fresh].slice(-40);
  if (fresh.length) { mkdirSync(dirname(doneFile(x.name)), { recursive: true, mode: 0o700 }); writeFileSync(doneFile(x.name), JSON.stringify(all), { mode: 0o600 }); }
  if (!U.lastCheck()) await U.refresh(c).catch(() => {});
  if (G.gitMode(c) && !G.lastInfo()) try { G.info(c); } catch {} // a git install's head / origin main+dev for Settings and relay_update's answer
  const rep = { done: all.slice(-20), phone_topic: /phone/.test(String(c.approve ?? "")) ? c.ntfy?.topic ?? null : null, release_key: x.releaseKey?.() ?? null, approve: c.approve ?? null, darwin,
    update: { ...U.report(c, undefined, loadPend(x.name).length ? loadPend(x.name) : null), nogate: true } }; // nogate: an app's ask installs the latest without the owner's approval (the server answers "updating", not waiting_approval)
  const j = JSON.stringify(rep); if (j !== lastReport) { await x.call("settings_report", { settings: rep }).catch(e => { if (!inst) throw e; }); lastReport = j; }
  if (inst) x.installed?.(inst);
  return changed;
}
// An agent's relay_update ask on a git install (runner.json "source", or a runner run from its checkout), handled HERE, in the runner process:
// no task is created and no coding agent is involved (owner, 2026-10-22). The server's dev flag (despite the name: the asker may send
// tasks here, Experimental or not) and the asker still one of the owner's own connected apps (op policy with from, live): this Mac fetches
// origin and resolves the newest commit of its channel, and installs the latest once idle with no approval (owner, 2026-10-22 22:00:
// "update is fine, just remove those barriers except it could only pull from latest"). Experimental only picks the channel, checked here
// against the owner's keys, never the server's word: on, origin/dev (else main); off, the branch the checkout tracks (git-channel.ts channels).
const busyLogged = new Set<string>();
async function devAsk(c: any, envelope: any, x: Ctx, q: any, by: string, id: string): Promise<{ done: any; owner?: boolean; why?: string } | { ask: DevAsk }> {
  const at = new Date().toISOString(), who = `${by} (relay_update)`, done = (ok: boolean, msg: string, o: any = {}) => ({ id, do: "relay_update", ok, msg, at, ...o });
  const refuse = (why: string, owner = false) => { U.recordOutcome({ result: "refused", why, from: G.lastInfo()?.head?.slice(0, 7) ?? null, to: null, release: null, by: who, at });
    x.audit({ type: "update", by: who, result: "refused", why, dev: !owner }); x.log(`update asked by ${by}: ${owner ? "waits for you" : "refused"}: ${why}`);
    return { done: done(false, `${by} asked; ${owner ? "waits for you" : "not updated"}: ${why}`, { state: owner ? "needs_owner" : "refused", why }), owner, why }; };
  if (q.dev !== true && q.auth !== true) return refuse(`${by} can't send tasks in this workspace, so it can't ask to update this Mac's code`);
  let s: any = null; try { s = (await x.call("policy", { from: by })).sender; } catch {}
  if (!s?.connected || !s?.own) return refuse(!s ? `the server didn't confirm ${by} is still one of your connected apps` : !s.connected ? `${by} isn't connected any more` : `only your own apps can ask; ${by} is ${s.why ?? "not one of them"}`);
  const k = await latest(c, envelope, x); if ("refused" in k) return refuse(k.refused, k.owner);
  if (k.state === "up_to_date") { x.log(`update asked by ${by}: already on the newest origin/${k.ref} (${k.from})`);
    return { done: done(true, `${by} asked; already on the newest origin/${k.ref} (${k.from})`, { state: "up_to_date", from: k.from, to: k.to, ref: k.ref }) }; }
  const ask: DevAsk = { kind: "dev", id, by, at, sha: k.want!, from: k.head!, ref: k.ref!, approved: { at, by: "app" },
    why: `${by} asked: updates to the newest ${k.ref} commit (${k.want!.slice(0, 7)} now) once its running tasks finish; no confirmation needed` };
  x.audit({ type: "update_ask", by: who, ref: k.ref, from: k.head, to: k.want, approved_by: "app (Let apps update Kitebook)" });
  x.log(`update asked by ${by}: ${k.from} -> ${k.to} (the newest origin/${k.ref}); updates once idle, no confirmation needed`); return { ask };
}
// the channel's newest commit right now (fetched here; channels() + devCheck with no target): what an ask installs, never anything else
async function latest(c: any, envelope: any, x?: Ctx): Promise<(G.DevResult & { want?: string; head?: string }) | { refused: string; owner?: boolean }> {
  const v = verifyEnvelope(envelope, c.ownerKeys, x?.space ?? c.space), exp = !("error" in v) && !!experimentalOn(v.policy);
  const src = G.sourceDir(c), ch = G.channels(src, exp); if ("why" in ch) return { refused: ch.why, owner: true };
  const GP = await import("./git-pull.ts"), k = G.devCheck(src, GP.state().origin ?? null, null, ch.refs);
  if (k.state === "up_to_date") return k;
  if (k.state !== "updated" || !k.want || !k.head) return { refused: k.why ?? "nothing to update to" };
  return k;
}
// a waiting ask, each pass: once the runner is idle, resolve the newest commit again (it may have moved since the ask) and move to exactly
// that (git-channel.ts devUpdate: fast-forward only, health check, roll back on failure). null: still busy. Otherwise the finished entry.
async function devPending(c: any, envelope: any, x: Ctx, q: DevAsk): Promise<any | null> {
  const who = `${q.by} (relay_update)`, fin = (ok: boolean, msg: string, o: any) => { busyLogged.delete(q.id);
    x.log(`update asked by ${q.by}: ${o.state}${o.why ? ": " + o.why : ""}`); return { id: q.id, do: "relay_update", ok, msg, at: new Date().toISOString(), from: q.from.slice(0, 7), ref: q.ref, ...o }; };
  if (!q.approved) { q.approved = { at: new Date().toISOString(), by: "app" }; delete q.code; delete q.expires; // an ask from before no-gate, still waiting for its code: an app's ask now
    q.why = `${q.by} asked: updates to the newest ${q.ref} commit once its running tasks finish; no confirmation needed`; x.log(`update asked by ${q.by}: no confirmation needed any more; updates to the newest ${q.ref} commit once idle`); }
  if (x.idle && !x.idle()) { if (!busyLogged.has(q.id)) { busyLogged.add(q.id); x.log(`update asked by ${q.by}: waiting until the running tasks finish`); } return null; }
  const k = await latest(c, envelope, x);
  if ("refused" in k) { U.recordOutcome({ result: "refused", why: k.refused, from: q.from.slice(0, 7), to: null, release: null, by: who, at: new Date().toISOString() });
    x.audit({ type: "update", by: who, result: "refused", why: k.refused, dev: true }); return fin(false, `${q.by} asked; not updated: ${k.refused}`, { state: "refused", why: k.refused }); }
  if (k.state === "up_to_date") return fin(true, `${q.by} asked; already on the newest origin/${k.ref} (${k.from})`, { state: "up_to_date", from: k.from, to: k.to, ref: k.ref });
  const o = await G.devUpdate(c, x.cfgPath, q.by, { sha: k.want!, how: "app", refs: [k.ref!] }, x);
  x.audit({ type: "update", by: who, result: o.state, from: o.from, to: o.to, ref: o.ref, why: o.why, sha: o.sha ?? k.want, health: o.health ?? null, dev: true, approved_by: "app" });
  const msg = o.state === "updated" ? `Updated by ${q.by} to ${o.to} (exactly ${k.want!.slice(0, 12)}, the newest origin/${o.ref}); health ok${G.ownCheckout(G.sourceDir(c)) ? "; it restarts once its tasks finish" : ""}`
    : o.state === "up_to_date" ? `${q.by} asked; already on ${k.want!.slice(0, 7)}` : o.state === "rolled_back" ? `${q.by} asked; tried ${o.to}, rolled back: ${o.why}` : o.state === "server_update_failed" ? `${q.by} asked; the server didn't take ${o.to}, so the server and the checkout went back: ${o.why}` : `${q.by} asked; not updated: ${o.why}`;
  return fin(o.state === "updated" || o.state === "up_to_date", msg, { state: o.state, from: o.from ?? q.from.slice(0, 7), to: o.to, sha: o.sha ?? k.want, health: o.health ?? null, why: o.why, approved_by: "app" });
}
// Settings -> Updates "Update now" (do update_ref ref main, the stable channel: any owner) and "Update to dev now" (ref dev, Experimental only): the owner's signed click is the approval a git ref otherwise needs at the
// terminal (service.ts gitUpdate's y/N). dev: only while the policy this Mac verifies itself has Experimental on. Only a fast-forward of the
// checkout this runner runs from (or runner.json "source"); the commit is pinned for that one update (updatePin), then the pin is cleared.
async function updateRef(c: any, envelope: any, x: Ctx, ref: string): Promise<string> {
  if (!UPDATE_REFS.includes(ref)) throw new Error(`ref: ${UPDATE_REFS.join(" | ")}`); // cmdShape already says so; checked again where git runs
  // main is the stable channel: Update now for every owner (the signed click checked above is the approval). dev needs Experimental.
  if (ref !== "main") { const v = verifyEnvelope(envelope, c.ownerKeys, x.space); if ("error" in v || !experimentalOn(v.policy)) throw new Error("Experimental is off: the dev channel needs Experimental (Update now follows main, the stable branch, without it)"); }
  if (!c.source && I.isInstalledPath(import.meta.path)) throw new Error("this Mac runs an installed release, not a git checkout, so there is no branch to update to; Update now installs the newest release");
  const src = resolve(String(c.source ?? join(dirname(import.meta.path), "..")).replace(/^~(?=\/|$)/, homedir()));
  const git = (...a: string[]) => { const p = Bun.spawnSync(["git", "-C", src, ...a], { stdout: "pipe", stderr: "pipe" }); return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
  const f = git("fetch", "-q", "origin"); if (f.code) throw new Error(`couldn't fetch ${src}: ${f.err.slice(0, 200)}`);
  const want = git("rev-parse", "--verify", "-q", `origin/${ref}^{commit}`), head = git("rev-parse", "HEAD").out;
  if (want.code) throw new Error(`there's no ${ref} branch on origin`);
  if (want.out === head) { // already there, but a server still on cf dev is part of this update: the owner's click (re)starts its upgrade
    if (!(await import("./host-upgrade.ts")).oldHost(c, x.cfgPath)) return `already on ${ref} (${head.slice(0, 7)})`;
    const { service } = await import("./service.ts"); const code = await service(x.cfgPath, ["update"], { inRunner: true });
    if (code) throw new Error(`already on ${ref}, but the server upgrade didn't start (see kitebook logs runner)`);
    return `already on ${ref} (${head.slice(0, 7)}); upgrading the old cf dev server now, then the runner restarts (log: ~/Library/Logs/kitebook-upgrade.log)`; }
  if (git("merge-base", "--is-ancestor", "HEAD", want.out).code) throw new Error(`${ref} (${want.out.slice(0, 7)}) isn't a fast-forward of what this Mac runs (${head.slice(0, 7)}); update it in Terminal`);
  c.updatePin = want.out; writeFileSync(x.cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 }); x.stamp(x.cfgPath);
  x.audit({ type: "update_ref", ref, to: want.out, from: head, how: ref === "main" ? "Update now, Settings click" : "Experimental, Settings click" });
  const { service } = await import("./service.ts"); let code = 1;
  try { code = await service(x.cfgPath, ["update"], { inRunner: true, by: "you, in Settings" }); } // the runner restarts itself once idle (not killed mid-click)
  finally { const now = JSON.parse(readFileSync(x.cfgPath, "utf8")); delete now.updatePin; for (const k of Object.keys(c)) delete c[k]; Object.assign(c, now); writeFileSync(x.cfgPath, JSON.stringify(c, null, 2), { mode: 0o600 }); x.stamp(x.cfgPath); }
  if (code) throw new Error(`the update to ${ref} didn't finish (see kitebook logs runner)`);
  return `updated to ${ref} (${want.out.slice(0, 7)}); it restarts once its tasks finish`;
}
let pokeAt = 0; export const poke = () => { pokeAt = Date.now(); }; // an event (update.requested, policy.updated) asks for a pass now
export function startSync(x: Ctx) {
  const every = Math.max(500, Number(process.env.KITEBOOK_SETTINGS_POLL_MS ?? 15_000) || 15_000); let last = 0, busy = false;
  return setInterval(async () => { const now = Date.now(); if (busy || (now - last < every && now > burstUntil && pokeAt <= last)) return; busy = true; last = now;
    try { await syncOnce(x); } catch (e: any) { if (!/policy: /.test(e.message)) x.log("settings sync:", e.message); } finally { busy = false; } }, 1000);
}
