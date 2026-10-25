// Runner side of the session tools (live-sessions; server: src/space/sessions.ts, store: client/sessions-store.ts).
//   sessions_search / session_get: the server announces a request (event sessions.requested, only this runner sees it); we fetch it
//     (sessions_take), check the OWNER-SIGNED policy ourselves (session access defaults to write; explicit off/read wins, signed by a browser key runner.json
//     pins, not older than the newest policy this computer accepted), read the owner's local sessions read-only, redacted, and answer
//     (sessions_reply; the server keeps it in memory until the asker reads it). A server can't grant this: an unsigned or forged policy reads nothing.
//   session tasks (task.session from session_create / session_send): sessionPrep() before the run. fork: a copy of the owner's session
//     seeds the NEW session (context transplant; the source is only read), or the agent's own fork through its live driver; continue:
//     running or uncertain originals use a copy; known-idle originals follow the owner-signed scope and approval choice.
//     Legacy in-place permissions still ask a person (runner-approval.ts).
// runner.json "sessions": false turns the session tools off on this computer (answers "refused"); KITEBOOK_SESSIONS_HOME (tests) reads another home.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { realpathSync } from "fs";
import { resolve, sep } from "path";
import { sessionLevel, sessionDecision, type SessionRule, type SessionIdentity } from "./session-policy.ts";
import { createHash } from "crypto";
import { cfg, cfgNow, call, log, me, on } from "./runner-ctx.ts";
import * as P from "./policy.ts";
import * as SS from "./sessions-store.ts";
import { audit } from "./runner-approval.ts";
import { agentDef, discoverModels } from "./runner-agents.ts";
import { liveFor } from "./live-driver.ts"; // session_send forks through the agent's own live driver when it can

const opts = (): SS.Opts => (process.env.KITEBOOK_SESSIONS_HOME ? { home: process.env.KITEBOOK_SESSIONS_HOME } : {});
const ownerKeys = (): string[] => { const k = (cfgNow() ?? cfg).ownerKeys; return Array.isArray(k) ? k.map(String) : []; };
let store: P.PolicyStore | null = null;
// advertise(): the server checks it's there. roots: each project's checkout folder as sha256(realpath), so session_create {cwd} / a fork
// from a session's folder finds its project without the server ever seeing a path
export async function advert(projects: Record<string, any> | undefined) {
  if (cfg.sessions === false) return null;
  const roots: Record<string, string> = {}; for (const [k, v] of Object.entries<any>(projects ?? {})) { if (!v?.path) continue; let p = String(v.path); try { p = realpathSync(p); } catch {} roots[k] = createHash("sha256").update(p.replace(/\/+$/, "")).digest("hex"); }
  return { v: 2, agents: [...SS.SESSION_AGENTS], modes: ["new", "fork", "continue"], roots };
}

// What the owner signed for this app: "off" | "read" | "write", or why it can't be trusted
export type SessionGrant = { level: "off" | "read" | "write"; why?: string; entry?: any; identity?: SessionIdentity };
export async function allowed(app: string): Promise<SessionGrant> {
  if (cfg.sessions === false) return { level: "off", why: `runner.json "sessions": false on this computer` };
  let r: any; try { r = await call("policy", { from: app }); } catch (e: any) { return { level: "off", why: `couldn't read your permissions (${e.message})` }; }
  store ??= P.storeFor(me.name); const verified = P.sessionAccess(r?.envelope, ownerKeys(), cfg.space, store, app); if (verified.level === "off") return verified;
  const entry = r.envelope.policy.apps?.[app], identity = r.session_identity, l = sessionLevel(entry, identity); return l === "read" || l === "write" ? { level: l, entry, identity } : { level: "off", why: `session access for ${app} is off or its saved consent ended (Settings -> Assistants -> Agent sessions)` };
}

const digest = (x: any) => createHash("sha256").update(JSON.stringify(x)).digest("hex");
const permits = new Map<string, { task: string; grant: string; expires: number }>();
const grantEntry = (g: SessionGrant) => g.entry ?? { sessions: g.level };
const taskKey = (t: any) => digest([t.id,t.from,t.project,t.agent,t.model,t.instructions,t.session,t.attempt]);
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
export function sessionProject(m: SS.Meta): string | null {
  const projects = Object.entries<any>(cfg.projects ?? {}).filter(([,p]) => p?.path).sort((a,b) => String(b[1].path).length - String(a[1].path).length);
  for (const [name,p] of projects) {
    const root = real(String(p.path)), cwd = m.cwd ? real(m.cwd) : "";
    if (cwd && (cwd === root || cwd.startsWith(root + sep)) || !cwd && m.agent === "gemini" && SS.cwdOk(m, root)) return name;
  }
  return null;
}
function decision(g: SessionGrant, project: string | null, action: "read" | "fork" | "continue") { return sessionDecision(grantEntry(g), g.identity, project, action); }
function manual(t: any, g: SessionGrant) { const p = permits.get(t.id); if (!p || p.expires <= Date.now()) { permits.delete(t.id); return false; } return p.task === taskKey(t) && p.grant === digest(grantEntry(g)); }
export async function markManual(t: any) {
  const g = await hooks.allowed(String(t.from ?? "")); if (g.level !== "write") return false;
  for (const [id,p] of permits) if (p.expires <= Date.now()) permits.delete(id);
  if (permits.size >= 256) permits.delete(permits.keys().next().value!);
  permits.set(t.id, { task: taskKey(t), grant: digest(grantEntry(g)), expires: Date.now() + 15 * 60_000 }); return true;
}
// The source's actual local folder decides scope, never a caller-supplied destination project.
export async function taskConsent(t: any, supplied?: SessionGrant) {
  const g = supplied ?? await hooks.allowed(String(t.from ?? "")); if (g.level !== "write") return { allowed: false, automatic: false, ask: true, why: g.why ?? "session access ended", keys: [] as string[], rule: false };
  let project = t.project ?? null, action: "fork" | "continue" = t.session?.mode === "continue" ? "continue" : "fork";
  if (t.session?.from) {
    const m = SS.find(t.session.agent,t.session.from,opts()); if (!m) return { allowed: false, automatic: false, ask: true, why: `no ${t.session.agent} session ${t.session.from} on this computer`, keys: [] as string[], rule: !!g.entry?.session_rule };
    project = sessionProject(m); const live = await SS.liveOf(m,opts()); if (live.live !== false) action = "fork";
  }
  const d = decision(g,project,action), r: SessionRule | undefined = g.entry?.session_rule;
  // Both the source and destination must be inside the saved automatic scope.
  const destination = !r || r.projects.includes(t.project);
  return { ...d, automatic: d.automatic && destination, ask: d.ask || !destination, why: destination ? d.why : "destination project is outside your saved permission", keys: r?.keys ?? [], rule: !!r };
}
function readable(g: SessionGrant, m: SS.Meta) { return decision(g,sessionProject(m),"read").allowed; }

const busy = new Set<string>();
export async function onRequest(id: string) {
  if (busy.has(id)) return; busy.add(id);
  try {
    let q: any; try { q = await call("sessions_take", { id }); } catch { return; } // expired, or not ours
    const reply = (ok: boolean, x: any) => call("sessions_reply", ok ? { id, ok: true, result: x } : { id, ok: false, error: String(x) }).catch(e => log("sessions reply", e.message));
    if (q.op === "models") { try { const r = await discoverModels(q.args?.agent ?? undefined, true); await reply(true, r); await on.advertise(); } catch (e: any) { await reply(false, e.message); } return; }
    const a = await hooks.allowed(q.from);
    if (a.level === "off") { audit({ type: "sessions_refused", from: q.from, op: q.op, why: a.why }); log(`sessions ${q.op} from ${q.from}: refused (${a.why})`); return reply(false, `refused: ${a.why}`); }
    try {
      const scoped = a.entry?.session_rule ? { ...opts(), filter: (m: SS.Meta) => readable(a,m) } : opts();
      if (q.op !== "search") { const m = SS.find(q.args?.agent,q.args?.id,opts()); if (!m && !a.entry?.session_rule) return reply(false,`no ${q.args.agent} session ${q.args.id} on this computer (sessions_search lists them)`); if (!m || !readable(a,m)) return reply(false,"refused: session is outside the projects you allowed; update this app in Settings → Connected apps"); }
      const r = q.op === "search" ? await SS.search(q.args ?? {}, scoped) : q.op === "get" ? await SS.get(q.args, opts()) : q.op === "status" ? await SS.status(q.args, opts()) : null;
      if (!r) return reply(false, `unknown request ${q.op}`);
      const after = await hooks.allowed(q.from);
      if (after.level === "off" || digest(grantEntry(after)) !== digest(grantEntry(a))) return reply(false, "refused: session access ended while reading");
      const n = "sessions" in r ? r.sessions.length : "messages" in r ? r.messages.length : 1;
      audit({ type: "sessions_read", from: q.from, op: q.op, agent: q.args?.agent ?? null, id: q.args?.id ?? null, n });
      log(`sessions ${q.op} from ${q.from}: ${"sessions" in r ? `${n} session(s)` : `${q.op === "status" ? "metadata" : `${n} message(s)`} of ${q.args.agent} ${q.args.id}`}`);
      return reply(true, r);
    } catch (e: any) { return reply(false, e?.message ?? String(e)); }
  } finally { busy.delete(id); }
}

// ---- session tasks ----
// A "context-transplant" fork: a summary of the owner's session seeded into a NEW session (the source is only read).
// Can this agent fork natively here? Its live driver is up (client/live-driver.ts liveFor) and says start({ fork }) works.
export const liveForks = async (agent: string) => !!(await liveFor(agent, "task"))?.forks;
// The live driver's start options for a task's next turn: a fork's first turn opens the agent's own copy of the owner's session; any later
// turn (and a parked task's resume) resumes the session the task already has; an in-place continue comes with sid + turns = 1 (runTask),
// so it goes through the driver's resume, which forks instead if the session is held elsewhere (Codex active writer, Claude agents --json).
export const liveStartOf = (r: { turns?: number; sid?: string | null; fork?: { from: string } | null }) =>
  ({ resume: r.turns ? r.sid ?? null : null, ...(!r.turns && r.fork ? { fork: r.fork } : {}) });
// withPreamble: put it just before the task text, where the prompt carries it when it's known up front
export const withPreamble = (prompt: string, pre: string) => { const i = prompt.indexOf("\nTask: "); return i < 0 ? `${pre}\n\n${prompt}` : `${prompt.slice(0, i)}\n${pre}\n${prompt.slice(i)}`; };
export const forkPreamble = async (agent: string, id: string) => (await SS.transplant(agent as any, id, opts())).text;
export const isSessionTask = (t: any) => !!t?.session && typeof t.session === "object";
// Can `agent` resume a session it didn't start, by that session's own id? Pi: its session file ({session}); an adapter: a resume flag that
// takes the captured id ({sid}). Copilot / Grok Build resume only the session Kitebook named for the task ({tasksid}), and an agent without
// a resume flag just gets the prompt again: an in-place continue there would silently run a NEW session, so it becomes a fork instead.
export const resumesById = (agent: string) => { const d = agentDef(agent); if (!d) return false;
  return agent === "pi" ? d.argv.some(a => a.includes("{session}")) : !!d.resume?.some(x => x.includes("{sid}")); };
// hooks (tests): the grant check, so a unit test needn't sign a policy and serve it
export const hooks = { allowed };
// Before a session task runs. preamble: text the prompt carries before the task (a fork's transplant); resume: the owner's session (id, or
// Pi's file) to continue in place; fork: for a live driver that forks natively ({from}); error: refuse with this. dry: checks only (before asking).
// The grant is checked here, not only by the server when the task was created: a fork or a continue reads the owner's transcript, so the
// owner-SIGNED policy has to permit write for the sender (the default, unless explicitly restricted) (same rule as onRequest: a server can't grant it), at the pre-approval check AND
// again when the run starts (runTask), so a task queued or waiting for approval dies once the owner takes the grant back.
// continue degrades to a fork (never in place) when we can't tell whether the session is open elsewhere, or the agent can't resume by id.
export async function sessionPrep(t: any, liveFork?: (agent: string) => boolean | Promise<boolean>, dry = false): Promise<{ preamble?: string; resume?: string; fork?: { from: string }; error?: string; note?: string }> {
  const s = t.session ?? {}; if (!s.mode) return {};
  const g = await hooks.allowed(String(t.from ?? ""));
  if (s.mode === "new" && !g.entry?.session_rule) return {};
  if (g.level !== "write") { const why = g.level === "read" ? `you let ${t.from} read your agent sessions, not continue them (Settings -> Assistants -> Agent sessions)` : g.why ?? "not allowed";
    audit({ type: "sessions_refused", task: t.id ?? null, from: t.from ?? null, op: s.mode, why }); return { error: `refused: ${why}` }; }
  if (s.mode !== "new" && !(SS.SESSION_AGENTS as readonly string[]).includes(String(s.agent))) return { error: `can't read ${s.agent} sessions on this computer` };
  const consent = await taskConsent(t,g);
  if (!consent.allowed) return { error: `refused: ${consent.why}` };
  if (consent.rule && consent.ask && !dry && !manual(t,g)) return { error: "refused: this session request needs fresh owner approval" };
  if (s.mode === "new") return {};
  const m = SS.find(s.agent, s.from, opts()); if (!m) return { error: `no ${s.agent} session ${s.from} on this computer (sessions_search lists them)` };
  const stillAllowed = async () => { const current = await hooks.allowed(String(t.from ?? "")); return current.level === "write" && digest(grantEntry(current)) === digest(grantEntry(g)); };
  const fork = async (note?: string) => {
    if (dry) return note ? { note } : {};
    audit({ type: "sessions_fork", task: t.id, from: t.from, agent: s.agent, id: s.from, ...(note ? { instead_of: "continue", why: note } : {}) });
    if (note) log(`session task ${t.id}: forking instead of continuing in place (${note})`);
    // the agent's own fork (a copy; Codex thread/fork, Claude forkSession) when its live driver is up here and the same agent runs the task;
    // if that live start then fails, the runner seeds the copy with forkPreamble() instead (the CLI path can't fork)
    if ((!t.agent || t.agent === s.agent) && await liveFork?.(s.agent)) return await stillAllowed() ? { fork: { from: s.from }, ...(note ? { note } : {}) } : { error: "refused: session permission changed before copying" };
    const preamble = await forkPreamble(s.agent,s.from);
    return await stillAllowed() ? { preamble, ...(note ? { note } : {}) } : { error: "refused: session permission changed while reading" };
  };
  if (s.mode === "fork") return fork();
  if (s.mode === "continue") {
    if (t.agent && t.agent !== s.agent) return { error: `that session belongs to ${s.agent}; ${t.agent} can't continue it in place (send it without mode to fork it)` };
    const lv = await SS.liveOf(m, opts());
    if (lv.live && g.entry?.session_rule) return fork("the original is running; continuing a copy instead");
    if (lv.live) return { error: `that ${s.agent} session is open right now (${lv.why}); continuing it would mix two writers. Send it again without mode (a fork) to continue a copy` };
    if (lv.live == null) return fork(`can't tell whether that ${s.agent} session is open elsewhere`);
    if (!resumesById(s.agent)) return fork(`${s.agent} here can't resume a session it didn't start`);
    if (dry) return {};
    if (!(await stillAllowed())) return { error: "refused: session permission changed before continuing" };
    audit({ type: "sessions_continue", task: t.id, from: t.from, agent: s.agent, id: s.from });
    return { resume: s.agent === "pi" ? m.file : s.from };
  }
  return { error: `unknown session mode ${s.mode}` };
}
