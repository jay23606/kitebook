// Runner approvals (gates v2): every ask is bound to the exact payload (client/approval.ts) and goes to the phone (ntfy + review page),
// the Mac dialog, the owner's /start Status page or the terminal; signed auto-run (client/sign.ts), chain approvals, approved-payload memory.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname, resolve } from "path";
import { homedir } from "os";
import { approvalWays } from "./setup.ts";
import * as A from "./approval.ts";
import * as S from "./sign.ts";
import * as G from "./guard.ts";
import { call, log, cfg, me, cfgPath, on, cfgNow } from "./runner-ctx.ts";
import * as P from "./policy.ts";
import { autorunPushOk } from "./payload.ts";
import * as L from "./local-approve.ts";
import { resolvePick } from "./runner-agents.ts";
import * as PL from "./platform.ts";

export const TEST_DIALOG = !!(process.env.KITEBOOK_TEST && process.env.KITEBOOK_TEST_DIALOG); // smoke only: act as a Mac whose dialog goes unanswered
export const waysEnv = () => TEST_DIALOG ? { darwin: true } : {};
export const untilAbort = (s: AbortSignal) => new Promise<null>(res => s.aborted ? res(null) : s.addEventListener("abort", () => res(null)));
// ---- approvals (gates v2): every ask is bound to the exact payload (client/approval.ts) ----
// An ask carries a 5-minute HMAC nonce over task id + payload hash; the short hash is shown in every prompt. On an answer the
// runner re-fetches the task and re-checks: changed or late -> void, ask again (until the 15-minute overall limit).
export type Ask = { task: string; hash: string; short: string; nonce: string; exp: number; text: string; view: any };
export type Answer = { yes: boolean; nonce: string; presence?: string } | { void: string } | null;
export type Way = (a: Ask, s: AbortSignal) => Promise<Answer>;
export const passkeys = (): A.Cred[] => cfg.approvePasskey ? (cfg.passkeys ?? []) : [];
// Phone approval through ntfy (https://ntfy.sh or your own ntfy server). Outbound only. The notification opens the server's
// one-time review page (full task, short hash, Approve/Reject). Without a passkey it also keeps the classic Approve/Reject
// buttons, which post "<word> <nonce>" to <topic>-reply where the runner listens. With approvePasskey only the page can approve.
// The server's one-time review page for an ask (full task, short hash, Approve/Reject; passkey-signed when approvePasskey is on).
// ownerOnly: nobody was sent the link (dialog path), so the server serves and decides it only for the owner's signed-in session
// (the /start Status card links it). A phone link goes to ntfy, where the phone may not be signed in, so it stays a capability.
export const openPage = (a: Ask, ownerOnly = false) => { const pks = passkeys();
  // a connection request (view.gate "connect") is not a task: its Ask.task is the request id, which the server's task table doesn't know
  return call("approval_page", { kind: "approve", task: a.view?.gate === "connect" ? undefined : a.task, nonce: a.nonce, expires_at: a.exp, view: a.view, ...(ownerOnly ? { owner_only: true } : {}),
    passkey: pks.length ? { rp_id: pks[0].rp, allow: pks.map(p => p.id) } : undefined }); };
export async function waitPage(page: any, a: Ask, s: AbortSignal): Promise<Answer> {
  const pks = passkeys();
  while (page && !s.aborted) {
    let w: any; try { w = await call("approval_wait", { id: page.id, wait: 20 }, s); } catch { if (s.aborted) return null; await Bun.sleep(2000); continue; }
    if (w.state === "pending") continue;
    if (w.state === "rejected") return { yes: false, nonce: a.nonce };
    if (w.state !== "approved") return null; // expired / closed: the window ends, bound() asks again
    if (pks.length) { const err = A.verifyAssertion(pks, w.response?.assertion, a.nonce); if (err) return { void: `passkey check failed (${err})` }; }
    return { yes: true, nonce: a.nonce };
  }
  return null;
}
// Dialog path (no phone): the same review page, owner-only, so the owner can also decide from the /start Status card on any device.
// A Kitebook server that can't serve it (older Kitebook) counts as this way failing, so the dialog alone carries the ask (both failing = ChannelDown).
export async function pageApprove(a: Ask, signal: AbortSignal): Promise<Answer> {
  let page: any; try { page = await openPage(a, true); } catch (e: any) { throw new Error("owner review page unavailable: " + e.message); }
  try { return await waitPage(page, a, signal); } finally { call("approval_wait", { id: page.id, close: true }).catch(() => {}); }
}
// Phone approval through ntfy (https://ntfy.sh or your own ntfy server). Outbound only. The notification opens the server's
// one-time review page (full task, short hash, Approve/Reject). Without a passkey it also keeps the classic Approve/Reject
// buttons, which post "<word> <nonce>" to <topic>-reply where the runner listens. With approvePasskey only the page can approve.
export async function phoneApprove(a: Ask, signal: AbortSignal): Promise<Answer> {
  const n = cfg.ntfy; if (!n?.topic) throw new Error("approve=phone needs ntfy.topic in runner.json");
  const server = (n.server ?? "https://ntfy.sh").replace(/\/$/, ""), reply = `${n.topic}-reply`, pks = passkeys();
  const auth: Record<string, string> = n.token ? { authorization: `Bearer ${n.token}` } : {};
  let page: any = null;
  try { page = await openPage(a); }
  catch (e: any) { if (pks.length) throw new Error("approvePasskey is on but the server can't serve the review page: " + e.message); log("review page unavailable, buttons only:", e.message); }
  const since = Math.floor(Date.now() / 1000) - 1;
  const act = (label: string, word: string) => ({ action: "http", label, url: `${server}/${reply}`, method: "POST", headers: auth, body: `${word} ${a.nonce}`, clear: true });
  const actions = [...(page ? [{ action: "view", label: pks.length ? "Review & approve" : "Review", url: `${cfg.url}${page.path}`, clear: true }] : []), ...(pks.length ? [] : [act("Approve", "approve"), act("Reject", "reject")])];
  let pub: Response; try { pub = await fetch(server, { method: "POST", headers: { "content-type": "application/json", ...auth }, signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    body: JSON.stringify({ topic: n.topic, title: a.view?.gate === "connect" ? `Kitebook: ${a.view.title}? [${a.short}]` : `Kitebook: approve task? [${a.short}]`, message: a.text.slice(0, 3500), priority: 4, tags: ["robot"], actions, ...(page ? { click: `${cfg.url}${page.path}` } : {}) }) }); }
  catch (e: any) { if (page) call("approval_wait", { id: page.id, close: true }).catch(() => {}); if (signal.aborted) return null; const m = `couldn't reach ntfy at ${server}: ${netErr(e)}`; approvalHealth(m); throw new ChannelDown(m); }
  if (!pub.ok) { if (page) call("approval_wait", { id: page.id, close: true }).catch(() => {}); const m = `ntfy at ${server} refused the push (HTTP ${pub.status}${pub.status === 401 || pub.status === 403 ? ": check ntfy.token" : ""})`; approvalHealth(m); throw new ChannelDown(m); }
  approvalHealth(null); // the owner can be asked again
  const stop = new AbortController(), s = AbortSignal.any([signal, stop.signal]);
  const viaNtfy = async (): Promise<Answer> => {
    while (!s.aborted) {
      try {
        const r = await fetch(`${server}/${reply}/json?since=${since}`, { headers: auth, signal: AbortSignal.any([s, AbortSignal.timeout(60_000)]) });
        const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader(); let buf = "";
        while (true) { const { value, done } = await reader.read(); if (done) break; buf += value;
          let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
            try { const m = JSON.parse(line), [w, nc] = String(m.message ?? "").split(" ");
              if (m.event !== "message" || !nc || !A.sameNonce(nc, a.nonce)) continue;
              if (w === "reject") return { yes: false, nonce: nc };
              if (w === "approve") { if (pks.length) { log("ignored a button approval: approvePasskey requires the review page"); continue; } return { yes: true, nonce: nc }; } } catch {} } }
      } catch { if (s.aborted) return null; await Bun.sleep(1000); }
    }
    return null;
  };
  const viaPage = () => waitPage(page, a, s);
  try { return await firstAnswer([viaNtfy(), viaPage()]); }
  finally { stop.abort(); if (page) call("approval_wait", { id: page.id, close: true }).catch(() => {}); }
}
// The desktop dialog on this OS (client/platform.ts): osascript on macOS, zenity / notify-send on a Linux desktop, a PowerShell message box on
// Windows. Answers Approve / Reject; timing out (or a dialog that can't start) is no answer.
export async function dialogApprove(a: Ask, signal: AbortSignal): Promise<Answer> {
  if (TEST_DIALOG) return untilAbort(signal); // smoke: a Mac dialog nobody answers
  const kind = PL.dialogKind(); if (!kind) throw new Error(`no desktop dialog on this ${PL.osName()} machine (no display, or no zenity / notify-send)`);
  const secs = Math.max(5, Math.floor((a.exp - Date.now()) / 1000));
  const d = PL.dialog(kind, a.text + `\n\nApproval ${a.short}`, a.view?.gate === "connect" ? "Kitebook: connect an app" : "Kitebook task", secs);
  const p = Bun.spawn(d.argv, { stdout: "pipe", stderr: "pipe", env: { ...process.env, ...(d.env ?? {}) }, windowsHide: true } as any);
  signal.addEventListener("abort", () => p.kill());
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (signal.aborted) return null;
  const w = d.answer(out, code); return w ? { yes: w === "approve", nonce: a.nonce } : null;
}
// first real answer wins; null once every way has ended without one. If EVERY way failed (ntfy down, osascript missing) nobody
// was asked at all, so that is ChannelDown (the task waits and is retried), never a "no" from the owner.
export function firstAnswer(ps: Promise<Answer>[]): Promise<Answer> {
  return new Promise((res, rej) => { let left = ps.length; const errs: string[] = []; if (!left) res(null);
    for (const p of ps) p.catch(e => { log("approval error", e.message); errs.push(e.message); return null; }).then(v => { if (v) res(v); else if (--left === 0) errs.length === ps.length ? rej(new ChannelDown(errs.join("; "))) : res(null); }); });
}
// Ask, then re-check the answer against the payload as it is NOW. Returns the approved payload hash, false (rejected/declined), or null (no answer).
// Approvals down (R10): a runner that asks on the phone, when every push way fails, still opens the owner-only review page and
// waits on it, so the task stays in awaiting_approval and the owner can Approve/Reject from /start Status. The push is retried
// with the same backoff as holdForApproval (30 s, 1 m ... 10 min) while the page stays open; whichever answers first wins. Only if
// the page fails too is it ChannelDown (task released to queued, retried later).
export async function withPageFallback(ways: Way[], a: Ask, win: AbortSignal): Promise<Answer> {
  let page: Promise<Answer> | null = null, n = 0, first = "";
  const stop = new AbortController(), s = AbortSignal.any([win, stop.signal]);
  try {
    while (!s.aborted) {
      const push = firstAnswer(ways.map(w => w(a, s)));
      try { const v = await (page ? Promise.race([push, page]) : push); if (v || !page) return v; return await page; } // push window ended: the page still decides
      catch (e: any) { if (!(e instanceof ChannelDown)) throw e;
        if (!page) { first = e.message;
          log(`approvals down: ${e.message} - task ${a.task} waits in awaiting_approval; approve or reject it on ${cfg.url}/start (Status), retrying the push meanwhile`);
          audit({ type: "approval_page_fallback", task: a.task, why: e.message.slice(0, 300) }); approvalHealth(e.message);
          page = pageApprove({ ...a, view: { ...a.view, approvals_down: first.slice(0, 300) } }, s).catch((e2: any) => { throw new ChannelDown(`${first}; ${e2.message}`); }); page.catch(() => {}); }
        const ms = Math.min(10 * 60_000, (Number(process.env.KITEBOOK_TEST && process.env.KITEBOOK_APPROVAL_RETRY_MS) || 30_000) * 2 ** n++);
        const v = await Promise.race([page, Bun.sleep(ms).then(() => undefined)]); if (v !== undefined) return v; }
    }
    return null;
  } finally { stop.abort(); }
}
export async function bound(task: string, base: { text: string; view: any }, payload: () => Promise<any>, ways: Way[], signal: AbortSignal, fallback = false): Promise<string | false | null> {
  const key = G.approvalKey(), deadline = Date.now() + 15 * 60_000, ttl = Number(process.env.KITEBOOK_TEST && process.env.KITEBOOK_APPROVAL_TTL_MS) || A.TTL_MS;
  let early = 0;
  while (Date.now() < deadline && !signal.aborted) {
    const m = A.mint(key, task, A.payloadHash(await payload()), Date.now(), Math.min(ttl, deadline - Date.now()));
    const a: Ask = { ...m, task, text: `${base.text}\n\nApproval code ${m.short} (valid 5 min; check it matches the review page)`, view: { ...base.view, hash: m.short, runner: me.name } };
    const done = new AbortController(), win = AbortSignal.any([signal, AbortSignal.timeout(m.exp - Date.now()), done.signal]);
    // the Mac-side way (bun runner.ts approve) answers any run or push ask too; the deploy/spend/send gate stays on the phone/dialog
    const main = fallback ? withPageFallback(ways, a, win) : firstAnswer(ways.map(w => w(a, win)));
    let r: Answer; try { r = base.view?.gate === "irreversible" ? await main : await Promise.race([main, L.localWay(me.name, a, win, log, audit)]); } finally { done.abort(); } // first answer wins: withdraw the other prompts
    if (signal.aborted) return null;
    if (!r) { if (Date.now() < m.exp - 1000 && ++early >= 2) return null; log("approval", m.short, "got no answer before it expired; asking again"); continue; } // ways that fail fast decline
    if ("void" in r) { log("approval", m.short, "void:", r.void, "- asking again"); audit({ type: "approval_void", task, hash: m.short, why: r.void }); continue; }
    if (!r.yes) return A.check(key, task, m.hash, r.nonce) === "mismatch" ? null : false;
    const now = A.payloadHash(await payload()), v = A.check(key, task, now, r.nonce);
    if (v === "ok") return now;
    const why = v === "expired" ? "answered after its 5-minute expiry" : "the task changed between ask and answer";
    log("approval", m.short, "void:", why, "- asking again"); audit({ type: "approval_void", task, hash: m.short, why });
  }
  return null;
}
// ---- "Approve on my phone / Mac" for a new app connection (the server's src/oauth.ts connectNew) ----
// The consent page (or /start's sign-in) opened a request in a browser that isn't signed in; the server tells this workspace's runners
// (connect.requested). The default is right here: `kitebook approve <code>` in Terminal, the code the page shows. The phone is only for
// when the owner asked for it on the page ("Send to my phone instead", offered only when ntfy is set up): no push for something the
// owner is doing at this computer. The answer goes back bound to the request's nonce; the server gives exactly what the page showed.
const connectSeen = new Set<string>();
export async function connectAsk(id: string) {
  if (connectSeen.has(id)) return; connectSeen.add(id);
  let r: any; try { r = await call("connect_get", { id }); } catch (e: any) { log("connection request", id, e.message); return; }
  if (r.status !== "pending" || r.expires < Date.now()) return;
  const what = r.kind === "login" ? `A browser wants to sign in to your Kitebook (${r.app})` : r.folder ? `${r.app} wants to connect (folder: ${r.folder})` : `${r.app} wants to connect`;
  const text = `${what}.\n${r.can}${r.kind === "login" ? "" : r.replace ? `\nIt replaces the old ${r.name} connection.` : ` It will be called ${r.name}.`}\n\nCode ${r.code}: approve only if you are connecting it right now and the code matches your screen.`;
  const a: Ask = { task: id, hash: r.code, short: r.code, nonce: r.nonce, exp: r.expires, text, view: { gate: "connect", login: r.kind === "login", title: what, app: r.app, can: r.can, name: r.name, replace: !!r.replace, hash: r.code, runner: me.name, asked_by: r.app } };
  const stop = new AbortController(), s = AbortSignal.any([stop.signal, AbortSignal.timeout(Math.max(1000, r.expires - Date.now()))]);
  (async () => { while (!s.aborted) { await Bun.sleep(3000); try { if ((await call("connect_get", { id })).status !== "pending") stop.abort(); } catch {} } })(); // answered elsewhere: withdraw
  const ways: Promise<Answer>[] = [L.localWay(me.name, a, s, log, audit)];
  if (r.phone && cfg.ntfy?.topic) ways.push(phoneApprove(a, s)); // only when asked for on the page
  log("connection request", r.code, "-", what, `- answer it with: kitebook approve ${r.code}${r.phone && cfg.ntfy?.topic ? " (or on your phone)" : ""}`);
  let ans: Answer = null;
  try { ans = await Promise.race([firstAnswer(ways), untilAbort(s)]); } catch (e: any) { log("connection request", r.code, "couldn't ask:", e.message); } finally { stop.abort(); }
  if (!ans) return; if ("void" in ans) { log("connection request", r.code, "not taken:", ans.void); return; }
  // a yes widens access: the server wants a presence assertion from this device (src/devices.ts). kitebook approve brings one; for the
  // dialog / phone answer the runner asks the presence key itself (Touch ID / the Keychain dialog / Windows Hello; none on a headless Linux)
  let presence: string | null = ans.presence ?? null;
  if (ans.yes && !presence) presence = await (await import("./device.ts")).assertFor(me.name, `connect:${id}`, `approve ${r.app} (code ${r.code})`).catch(() => null);
  try { const d = await call("connect_decide", { id, nonce: ans.nonce, yes: ans.yes, ...(presence ? { presence } : {}) }); log("connection request", r.code, d.state === "approved" ? `approved: ${r.app} connects as ${d.name}` : "declined"); audit({ type: "connect_decided", request: id, code: r.code, app: r.app, yes: ans.yes }); }
  catch (e: any) { log("connection request", r.code, "answer not taken:", e.message); }
}
export const audit = (e: any) => { try { if (G.caps().protect?.auditLog) G.auditAppend({ ...e, runner: me.name }); } catch {} };
export let nonces: S.Nonces; export const signedRuns = new Set<string>(); // signed dispatch: seen nonces, tasks whose signature checked out
// chain child: fetch the signed parent (its chain definition) and the step it follows, then check it against what the parent signed
// signed auto-run: the KB list each signature allows (a chain child gets its signed parent's), re-applied on a retry of the same task
export const signedKb = new Map<string, S.KbPair[] | null>();
// KB provenance (R8): whose notes count. runner.json trustedKbAuthors when set (this runner always: its own kb.sync memory and learnings),
// else this runner + every dispatcher whose key the owner trusted. Read live, so a runner.json edit applies to the next task.
export function kbTrust(): Set<string> { const l = Array.isArray(cfg.trustedKbAuthors) ? cfg.trustedKbAuthors.map(String) : Object.keys(cfg.trustedKeys ?? {}); return new Set([me.name, ...l]); }
export const kbUntrusted = (t: any) => (t.kb_context ?? []).filter((x: any) => !(x.author && kbTrust().has(String(x.author))));
export async function chainTrust(t: any, keys: Record<string, string[] | string> | undefined = cfg.trustedKeys): Promise<string> {
  try { const r = await call("task_get", { id: t.parent_id }), prev = await call("task_get", { id: t.continue_from });
    const v = S.verifyChainChild(t, { ...r, chain: r.chain_def ?? null }, prev, me.name, keys, nonces); if (v === "ok") signedKb.set(t.id, r.limits?._sig?.kb ?? null); return v;
  } catch (e: any) { return `chain parent unavailable: ${e.message}`; }
}
// Signed auto-run: only the KB entries the sender signed (id + hash) and whose author this runner trusts (kbTrust) reach the agent;
// injected, altered or untrusted-author ones are dropped and audited. Mutates t in place, so the approval hash (runPayload) and the
// prompt both see the filtered list.
export function keepSignedKb(t: any, loud: boolean) {
  for (const d of S.keepSignedKb(t, signedKb.get(t.id), kbTrust())) if (loud) { log("kb entry dropped from signed task", t.id, "-", d.id, "-", d.why);
    audit(d.untrusted ? { type: "kb_untrusted_author_dropped", task: t.id, from: t.from, entry: d.id, author: d.author ?? null } : { type: "kb_unsigned_dropped", task: t.id, from: t.from, entry: d.id, why: d.why }); }
}
// unsigned chain child: the root (its chain definition, as the server has it now) and the step it follows, checked against the approval recorded at step 1
export async function approvedChain(t: any): Promise<"ok" | null | string> {
  try { const r = await call("task_get", { id: t.parent_id }), prev = await call("task_get", { id: t.continue_from });
    return S.checkApprovedChain(t, { ...r, chain: r.chain_def ?? null }, prev, nonces);
  } catch (e: any) { return `chain parent unavailable: ${e.message}`; }
}
// ---- the owner's standing permissions (client/policy.ts): set once on /start, no prompt for each task ----
export const policyRuns = new Map<string, any>(); // task id -> the policy entry it ran under (its push gate reads it)
export const policyAd: { seq: number | null; error: string | null } = { seq: null, error: null }; // advertised: which version this Mac uses
const ownerKeys = (): string[] => { const k = (cfgNow() ?? cfg).ownerKeys; return Array.isArray(k) ? k.map(String) : []; }; // read live: a browser trusted from Settings applies at once
let pStore: P.PolicyStore | null = null;
export const autorunRuns = new Set<string>(); // tasks that ran without asking because of "Run tasks without asking" (task_approval says so; Status shows it)
export async function standing(t: any): Promise<P.Standing & { sender?: { connected: boolean; own: boolean; why?: string } }> {
  let r: any; try { r = await call("policy", { from: t.from }); } catch (e: any) { return { why: `couldn't read your permissions from the server (${e.message})`, seq: null }; }
  pStore ??= P.storeFor(me.name);
  const st: any = P.standingFor(r.envelope, ownerKeys(), cfg.space, pStore, t.from, t.project); if (st.autorun) st.sender = r.sender ?? null;
  const err = "entry" in st || st.seq != null || st.quiet ? null : st.why; if (st.seq != null) policyAd.seq = st.seq;
  if (err !== policyAd.error) { policyAd.error = err; on.advertise().catch(() => {}); }
  return st;
}
export const policyAdvert = () => ({ owner_keys: ownerKeys().map(P.fingerprint), seq: policyAd.seq, ...(policyAd.error ? { error: policyAd.error.slice(0, 300) } : {}) });
export const approvals = new Map<string, AbortController>(); // task id -> pending prompt, withdrawn if the task is cancelled
// Run approval (and push approval when `ask` is set). Returns the approved payload hash, false (the owner said no), or null (no answer).
export class Unreachable extends Error {} // no way to ask the owner (config): reject with the fix instead of a silent "declined"
export class ChannelDown extends Error {} // the ways are configured but every one failed just now: keep the task queued and retry with backoff
export const netErr = (e: any) => `${e?.code && !String(e.message ?? "").includes(e.code) ? e.code + ": " : ""}${e?.message ?? e}`;
// Advertised in shared/runners/<name>.json (approval: {ok, error, since}) so peers and the /start Status card flag this runner.
export let approvalDown: { error: string; since: string } | null = null;
export function approvalHealth(err: string | null) {
  if ((approvalDown?.error ?? null) === err) return;
  approvalDown = err ? { error: err.slice(0, 300), since: approvalDown?.since ?? new Date().toISOString() } : null;
  if (!err) log("approval channel reachable again");
  on.advertise().catch(() => {});
}
export async function approve(t: any, proj: any, ask?: { text: string; gate: string; payload: () => Promise<any>; branch?: string; defaultBranch?: string | null; force?: boolean }): Promise<string | false | null> {
  const ins = String(t.instructions), pk0 = resolvePick(t, proj), agent = typeof pk0 === "string" ? proj.agent : pk0.agent, model = typeof pk0 === "string" ? null : pk0.model;
  let text = ask?.text ?? `${t.from} asks ${me.name} to run a task\n\n${t.title}\nproject: ${t.project}  agent: ${agent}${model ? ` / ${model}` : ""}${t.continue_from ? `  (follow-up on ${t.continue_from})` : ""}${t.session?.mode === "continue" ? `\nCONTINUES YOUR OWN ${String(t.session.agent).toUpperCase()} SESSION ${t.session.from} IN PLACE (it writes into that conversation)` : t.session?.mode === "fork" ? `\nforks (copies) your ${t.session.agent} session ${t.session.from}; the original isn't changed` : ""}\nverify: ${t.verify ?? "-"}\nscope: ${(t.scope ?? []).join(", ") || "whole project"}${t.spec ? `\nspec: ${t.spec.mode}${t.spec.promoted ? " (promoted from its plan)" : ""}${t.spec.acceptance.length ? `  acceptance: ${t.spec.acceptance.join(" ; ")}` : ""}${t.spec.forbidden.length ? `  forbidden: ${t.spec.forbidden.join(", ")}` : ""}` : ""}\n\n${ins.length > 1500 ? ins.slice(0, 1500) + `\n… (+${ins.length - 1500} more chars; full text on the review page and in tasks/${t.id}/task.md)` : ins}`;
  // unsigned chain, step 1: the approval also covers the chain definition (S.chainDefHash), so later steps that match it don't ask again
  const chainRoot = !ask && S.isUnsignedChainRoot(t); let last: any = null;
  const payloadOf = (x: any) => ({ ...runPayload(x, proj), chain_def: S.chainDefHash({ ...x, chain: x.chain_def }) }); // x: task_get (chain_def = the definition)
  const plain = async () => runPayload(await call("task_get", { id: t.id }), proj);
  const payload = ask?.payload ?? (chainRoot ? async () => payloadOf(last = await call("task_get", { id: t.id })) : plain);
  // what the caller gets back is always the plain run payload hash (it re-checks the task against it); the chain is recorded here
  const fin = async (h: string | false): Promise<string | false> => { if (!h || !chainRoot) return h;
    if (!last || h !== A.payloadHash(payloadOf(last))) return false; // can't happen (bound returns the hash of its last fetch); never record on doubt
    const root = { ...last, chain: last.chain_def }, dh = S.approveChain(root, nonces); log("chain approved:", t.id, `${root.chain.steps.length} steps, definition ${dh.slice(0, 8)}`); audit({ type: "chain_approved", task: t.id, def: dh.slice(0, 16) });
    return A.payloadHash(runPayload(last, proj)); };
  // approve=auto: with requireSignedAuto only a valid signature from a key the owner trusted auto-runs (checked once, at run approval;
  // its push approval rides on it). Without it the old name-based rule applies (warned at startup). Everything else asks a human.
  const named = !cfg.trusted?.length || cfg.trusted.includes(t.from);
  let why = "", stand = "";
  // continuing one of the owner's OWN agent sessions in place (session_send mode steer, client/runner-sessions.ts): always a human's yes,
  // whatever approve=auto, a signature, a standing permission or autorun would say
  const inPlace = !ask && t.session?.mode === "continue";
  if (inPlace) { why = "it continues one of your own agent sessions in place"; log("asking a human:", t.id, "-", why); }
  if (ask?.gate === "push" && policyRuns.has(t.id)) { const e = policyRuns.get(t.id), ar = autorunRuns.has(t.id);
    // autorun: the task's own branch only; the default branch or a force push asks (one tap) whatever the switch says (payload.ts autorunPushOk)
    if (e.push && (e.until == null || Number(e.until) > Date.now()) && (!ar || autorunPushOk(ask.branch, ask.defaultBranch, !!ask.force))) {
      log(ar ? "push allowed by Run tasks without asking (task branch):" : "push allowed by your permission:", t.id); audit({ type: ar ? "autorun_push" : "policy_push", task: t.id, branch: ask.branch ?? null }); return A.payloadHash(await ask.payload()); } }
  if (cfg.approve === "auto" && !ask && !inPlace) { let v = S.verifyTask(t, me.name, cfg.trustedKeys, nonces);
    if (v === "ok") signedKb.set(t.id, (t.signature ?? t.limits?._sig)?.kb ?? null);
    if (v === "unsigned" && t.parent_id && t.chain_step) v = await chainTrust(t); // a chain child inherits its signed parent's trust
    if (v === "ok") { signedRuns.add(t.id); log("signature ok:", t.id, "signed by", t.from); keepSignedKb(t, true); } else if (cfg.requireSignedAuto === true || v !== "unsigned") { why = v; log("not auto-running", t.id, "-", v, "- asking a human"); audit({ type: "signature_fallback", task: t.id, from: t.from, why: v }); } }
  // The owner's standing permission (any approve mode: it never turns on approve=auto; checked after approve=auto's own signature check, so that keeps its timing): the owner-signed policy lets this sender
  // run in this project now, and the task carries a valid signature from a key that policy names for it. Push still asks unless ticked.
  if (!ask && !inPlace && !signedRuns.has(t.id) && (!scratchOf(t, proj) || await autorunMaybe())) { const st = await standing(t);
    // autorun covers the owner's OWN apps only, and only while they're still connected (the live check: removed, ended, a person or a Mac -> ask)
    const sw = "entry" in st && st.autorun ? autorunSenderWhy(t.from, st.sender) : null;
    if (sw) { stand = sw; log("not running on its own", t.id, "-", sw); audit({ type: "autorun_refused", task: t.id, from: t.from, why: sw }); }
    else if ("entry" in st && (st.autorun || !scratchOf(t, proj))) { const tk = st.autorun ? cfg.trustedKeys?.[t.from] : null, keys = { [t.from]: [...(st.entry.keys ?? []), ...(tk ? (Array.isArray(tk) ? tk : [tk]) : [])] };
      let v = S.verifyTask(t, me.name, keys, nonces, Date.now(), S.POLICY_WINDOW);
      if (v === "ok") signedKb.set(t.id, (t.signature ?? t.limits?._sig)?.kb ?? null);
      if (v === "unsigned" && t.parent_id && t.chain_step) v = await chainTrust(t, keys);
      if (v === "ok") { policyRuns.set(t.id, st.entry); if (st.autorun) autorunRuns.add(t.id); keepSignedKb(t, true);
        if (st.autorun) log("runs without asking (Run tasks without asking, version", st.seq + "):", t.id, "from", t.from, "in", t.project ?? "a machine task"); else log("runs on its own (your permission, version", st.seq + "):", t.id, "from", t.from, "in", t.project);
        audit({ type: "policy_auto", task: t.id, from: t.from, project: t.project ?? null, seq: st.seq, ...(st.autorun ? { autorun: true } : {}) }); // every auto-run is in the audit log
        return A.payloadHash(runPayload(t, proj)); }
      stand = st.autorun ? `"Run tasks without asking" is on, but ${SIG_WHY[v] ?? v}` : `your permission for ${t.from} in ${t.project} is set, but ${SIG_WHY[v] ?? v}`; log("not running on its own", t.id, "-", stand); audit({ type: "policy_fallback", task: t.id, from: t.from, why: v, ...(st.autorun ? { autorun: true } : {}) });
    } else if ("why" in st && !st.quiet) stand = st.why; }
  // a steer, an agent asking mid-task to go past its sandbox (live drivers, gate "agent"), or an in-place continue of an owner session always asks a person, even with approve=auto
  if (ask?.gate !== "steer" && ask?.gate !== "agent" && !inPlace && cfg.approve === "auto" && named && (ask ? signedRuns.has(t.id) || cfg.requireSignedAuto !== true : signedRuns.has(t.id) || (cfg.requireSignedAuto !== true && !why))) {
    if (cfg.ntfy?.topic && !ask) fetch((cfg.ntfy.server ?? "https://ntfy.sh").replace(/\/$/, ""), { method: "POST", headers: { "content-type": "application/json", ...(cfg.ntfy.token ? { authorization: `Bearer ${cfg.ntfy.token}` } : {}) },
      body: JSON.stringify({ topic: cfg.ntfy.topic, title: "Kitebook: running task", message: `Ran on its own: ${autoWhy(t)}\n\n${text}`.slice(0, 1500), priority: 2, tags: ["robot"] }) }).catch(() => {});
    return A.payloadHash(!ask && signedRuns.has(t.id) ? runPayload(t, proj) : ask ? await payload() : await plain()); // signed: exactly the task that was verified, never a re-fetch
  }
  let reask = "";
  if (!ask && t.parent_id && t.chain_step != null && !signedRuns.has(t.id)) { // a later step of an unsigned chain the owner already approved
    const c = await approvedChain(t);
    if (c === "ok") { log("chain step matches the approved chain, not asking again:", t.id); audit({ type: "chain_step_approved", task: t.id, chain: t.parent_id }); return A.payloadHash(runPayload(t, proj)); }
    if (c) { log("asking again for", t.id, "-", c); text = `Asking again: ${c}\n\n${text}`; reask = c; }
  }
  const unt = ask ? [] : kbUntrusted(t); // the owner sees which KB notes come from authors this runner doesn't trust (labeled the same in the prompt)
  if (unt.length) text += `\n\nKB notes from untrusted authors (the agent sees them labeled untrusted): ${unt.map((x: any) => `${x.id} by ${x.author ?? "unknown"}: ${String(x.text).replace(/\s+/g, " ").slice(0, 160)}`).join(" | ")}`;
  if (chainRoot) text += `\n\nApproving this approves the whole ${t.chain.steps.length}-step chain: later steps run without asking if they match it exactly; any change asks again.`;
  const view = { gate: ask?.gate ?? "run", title: t.title, from: t.from, project: t.project, agent, model, verify: t.verify, access: cfg.access ?? "worktree",
    scope: t.scope, continue_from: t.continue_from, instructions: ins.slice(0, 50_000), acceptance: t.acceptance, detail: ask ? ask.text : undefined,
    ...(unt.length ? { kb_untrusted: unt.map((x: any) => ({ id: x.id, author: x.author ?? null, text: String(x.text).slice(0, 1200) })) } : {}),
    // C23, above the fold on the review page: who asked, why it asks, what it can touch, which shared notes it gets (and who wrote them)
    asked_by: t.from, why: (stand && !ask ? `Not run on its own: ${stand}. ` : "") + askWhy(t, ask, why, reask, chainRoot, named), touch: touchOf(t, proj), kb_notes: ask ? [] : kbNotes(t),
    ...(!ask && !scratchOf(t, proj) && t.project ? { allow: { app: t.from, project: t.project } } : {}) }; // the review page's "Always allow <app> in <project>"
  // untrusted sender under approve=auto: ask on the phone when ntfy is set (a headless Mac's dialog goes unseen), else the Mac dialog.
  // Unset approve: dialog on macOS (+phone with ntfy), phone elsewhere, terminal only with a TTY, else the review page (setup.ts approvalWays).
  const aw = approvalWays(cfg, cfgPath, waysEnv()); if ("error" in aw) throw new Unreachable(aw.error);
  log(ask ? `asking approval (${ask.gate}) for` : "asking approval for", t.id, t.title); // only now: signed auto-runs and approved chain steps never ask
  if (why) { (view as any).signature = why; text = `Not auto-run: ${why}\n\n${text}`; }
  const ways: Way[] = [];
  if (aw.ways.includes("phone")) ways.push(phoneApprove);
  if (aw.ways.includes("dialog")) ways.push(dialogApprove);
  if ((aw.ways.includes("dialog") || aw.ways.includes("browser")) && !aw.ways.includes("phone")) ways.push(pageApprove); // owner can also decide from /start Status (owner-only page); browser mode: that page + kitebook approve
  const ac = new AbortController(); if (!ask) approvals.set(t.id, ac);
  try {
    if (ways.length) { // first answer wins, the other prompt is withdrawn
      const r = await bound(t.id, { text, view }, payload, ways, ac.signal, aw.ways.includes("phone")); // phone runners: the Status page is the fallback (R10)
      if (ac.signal.aborted) throw new Error("cancelled");
      return r ? fin(r) : r === false ? false : null; // null: no answer (honest approvals), never recorded as a chain approval
    }
    while (true) { // terminal: same binding, re-checked after the answer
      const h0 = A.payloadHash(await payload()); process.stdout.write(`\n${text}\n\nApproval code ${A.shortHash(h0)}. Approve? [y/N] `);
      let yes = false; for await (const line of console) { yes = line.trim().toLowerCase() === "y"; break; }
      if (!yes) return false;
      const h1 = A.payloadHash(await payload()); if (h1 === h0) return fin(h1);
      log("approval void: the task changed while you were answering; asking again");
    }
  } finally { approvals.delete(t.id); }
}
// a machine task (no project) asks before reading the policy at all, unless autorun might cover it: read it only when it's on (cheap)
let arSeen = 0, arLast = false;
async function autorunMaybe(): Promise<boolean> { if (Date.now() - arSeen < 5000) return arLast;
  try { const r = await call("policy", {}), p = r?.envelope?.policy; arLast = !!(p?.autorun ?? p?.dev); } catch { arLast = false; } arSeen = Date.now(); return arLast; } // dev: autorun's old name
// null when autorun may cover a task from `from`, else why not (plain words for the review page)
export function autorunSenderWhy(from: string, s: { connected?: boolean; own?: boolean; why?: string } | null | undefined): string | null {
  if (!s) return `"Run tasks without asking" is on, but the server didn't confirm ${from} is still one of your connected apps`;
  if (!s.connected) return `"Run tasks without asking" is on, but ${from} isn't connected any more (removed, or its access ended)`;
  if (!s.own) return `"Run tasks without asking" covers only your own apps (assistants and coding agents); ${from} is ${s.why ?? "not one of them"}`;
  return null;
}
// ---- plain-words review page parts (C23): no internal terms ----
const SIG_WHY: Record<string, string> = { unsigned: "the request isn't signed" };
function autoWhy(t: any): string {
  if (signedRuns.has(t.id)) return t.parent_id && t.chain_step ? `step ${Number(t.chain_step) + 1} of a chain ${t.from} signed with a key you trust` : `signed by ${t.from} with a key you trust`;
  return cfg.trusted?.length ? `${t.from} is on this Mac's trusted list (approval setting: auto, signatures not required)` : "approval setting is auto and signatures aren't required";
}
function askWhy(t: any, ask: any, sig: string, reask: string, chainRoot: boolean, named: boolean): string {
  if (ask?.gate === "push" && autorunRuns.has(t.id)) return `The task ran without asking (Run tasks without asking is on). It wants to push ${ask.branch ?? "a branch"}${ask.defaultBranch ? ` and ${ask.defaultBranch} is the main branch` : ""}: that switch pushes only a task's own branch by itself, never the main branch or a force push.`;
  if (ask?.gate === "push" && policyRuns.has(t.id)) return `The task ran on its own (your permission for ${t.from} in ${t.project}). It finished and wants to push its branch: that permission doesn't include pushing.`;
  if (ask?.gate === "push") return `${signedRuns.has(t.id) ? `The task ran on its own (${autoWhy(t)}). ` : ""}It finished and wants to push its branch: this project is set to ask before pushing.`;
  if (ask?.gate === "irreversible") return "The agent wants to do something that can't be undone; it waits for you.";
  if (ask?.gate === "steer") return `${t.from} sent more instructions after you approved this task${signedRuns.has(t.id) ? " (its signature covers the task, not text added later)" : ""}. The agent gets them only if you approve.`;
  if (ask?.gate === "agent") return "The agent asks to do something its sandbox doesn't allow by itself, in the middle of this task. It waits for you; no answer in time means no.";
  if (ask) return "The runner needs your OK for this step.";
  if (reask) return `Step ${Number(t.chain_step) + 1} of a chain you approved, asking again because ${reask}.`;
  const base = sig ? `Not run on its own: ${SIG_WHY[sig] ?? sig}.` : cfg.approve === "auto" && !named ? `Not run on its own: ${t.from} isn't on this Mac's trusted list.` : "This Mac asks you before every task.";
  return chainRoot ? `${base} It is step 1 of a ${t.chain.steps.length}-step chain: approving it approves the whole chain (a later step that differs asks again).` : base;
}
const scratchOf = (t: any, proj: any) => !!proj?.scratch || !t.project || t.project === "home";
function touchOf(t: any, proj: any) {
  const scratch = !!proj?.scratch || !t.project || t.project === "home", push = proj?.push ?? "never";
  return { project: scratch ? "none (a machine task in an empty scratch folder)" : t.project,
    access: cfg.access === "full" ? "the whole Mac (full access)" : scratch ? "only its scratch folder" : "only its own copy of the project (a separate worktree and branch)",
    paths: (t.scope ?? []).length ? t.scope : scratch ? [] : ["the whole project"],
    network: "yes: Kitebook doesn't cut the agent off the internet (the guard blocks commands to payment and email services)",
    push: scratch ? "nothing to push" : push === "auto" ? "pushes its own branch automatically (never main)" : push === "ask" ? "asks you before pushing its branch" : "never pushes: the branch stays on this Mac" };
}
const kbNotes = (t: any) => (t.kb_context ?? []).slice(0, 20).map((x: any) => ({ id: x.id, title: String(x.title ?? x.id ?? "").slice(0, 120), author: x.author ?? null, trusted: !!(x.author && kbTrust().has(String(x.author))) }));
// what a run approval covers: the task as the server has it now + the agent/model/access this runner would use
export const repoProject = new Map<string, string>(); // task id -> project this runner mapped its `repo` to (re-fetched tasks get the same answer)
export function runPayload(t: any, proj: any) { if (!t.project && t.repo && repoProject.has(t.id)) t = { ...t, project: repoProject.get(t.id) }; const pk = resolvePick(t, proj); return A.payloadOf(t, { agent: typeof pk === "string" ? `invalid: ${pk}` : pk.agent, model: typeof pk === "string" ? null : pk.model, access: cfg.access ?? "worktree" }); }

// Approved payload hashes, on disk so an automatic retry after a crash can tell it's the same payload the owner said yes to.
export let approvedFile = "";
export const approvedAll = (): Record<string, string> => { try { return JSON.parse(readFileSync(approvedFile, "utf8")); } catch { return {}; } };
export const approvedHash = (id: string) => approvedAll()[id] ?? null;
export function rememberApproval(id: string, hash: string | null) { const m = approvedAll(); if (hash) m[id] = hash; else delete m[id]; try { mkdirSync(dirname(approvedFile), { recursive: true }); writeFileSync(approvedFile, JSON.stringify(m)); } catch {} }
// Files named after this runner: set once `me` is known (runner.ts calls this where these used to be computed).
export function initApproval() {
  nonces = new S.Nonces(join(homedir(), ".kitebook", `nonces-${me.name}.json`));
  approvedFile = join(homedir(), ".kitebook", `approved-${me.name}.json`);
}
