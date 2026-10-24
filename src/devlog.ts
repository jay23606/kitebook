// Recent logs and errors for Experimental (owner's request 2026-10-21, then called dev mode: "add to dev mode, the holding logs/errors"). When the Mac's
// /api/auth/* answered bare 500s, a cloud assistant couldn't see why; the owner had to run `kitebook logs server` and paste. Now:
//   - the server keeps a bounded ring per account (this Dir's SQLite, so it survives restarts): every unhandled error and 500 from any
//     route (the front door, an op in a Space, Better Auth init/migration/handler failures) with route, status, message, stack, request id;
//   - the Mac's runner keeps its own ring (client/devlog.ts) and, while Experimental is on, sends it here (runner op logs_report);
//   - everything is redacted before it is stored (client/redact.ts redactLog + the server's own env values, i.e. .dev.vars), and capped:
//     per source the newest CAP.lines non-error lines and CAP.errors errors; a message is cut at 2000 chars, a stack at 4000.
// Who reads it (op relay_logs, src/space/peers.ts): the owner's Mac (runner token: `kitebook logs --errors`) and Settings always; an
// assistant or coding agent with dispatch rights only while Experimental is on and it is one of the owner's own connected apps.
import { redactLog } from "../client/redact.ts";

export const SOURCES = ["server", "runner", "auth", "updates"] as const;
export const LEVELS = ["debug", "info", "warn", "error"] as const;
export const CAP = { lines: 500, errors: 200, msg: 2000, stack: 4000, batch: 200 };
export const DEVLOG_SCHEMA = `create table if not exists devlog(id integer primary key autoincrement, ts integer, source text, level text, msg text,
  route text, status integer, stack text, rid text, runner text);
create index if not exists devlog_src on devlog(source, level, id);`;
export type Entry = { ts?: number; source?: string; level?: string; msg?: string; route?: string | null; status?: number | null; stack?: string | null; request_id?: string | null; runner?: string | null };
type Sql = { exec(q: string, ...a: any[]): { toArray(): any[] } };

// the server's own secrets: every string env value that looks like one (ADMIN_TOKEN, BETTER_AUTH_SECRET, S3 keys, .dev.vars...)
export function envSecrets(env: any): string[] {
  const out: string[] = []; if (!env || typeof env !== "object") return out;
  for (const [k, v] of Object.entries(env)) if (typeof v === "string" && v.length >= 12 && !/^https?:\/\//.test(v) && !/^(true|false|\d+)$/.test(v) && /SECRET|TOKEN|KEY|PASS|AUTH|CRED|SALT|PRIVATE/i.test(k)) out.push(v);
  return out;
}
export const rid = () => "req_" + [...crypto.getRandomValues(new Uint8Array(8))].map(b => b.toString(16).padStart(2, "0")).join("");
const cut = (s: any, n: number) => { const t = String(s ?? ""); return t.length > n ? t.slice(0, n) + "…" : t; };
export function clean(e: Entry, known: string[] = []): Required<Entry> {
  const source = (SOURCES as readonly string[]).includes(String(e.source)) ? String(e.source) : "server";
  const level = (LEVELS as readonly string[]).includes(String(e.level)) ? String(e.level) : "info";
  const ts = Number.isFinite(Number(e.ts)) && Number(e.ts) > 0 ? Math.min(Number(e.ts), Date.now() + 60_000) : Date.now();
  const R = (s: any, n: number) => s == null || s === "" ? null : cut(redactLog(String(s), known), n);
  return { ts, source, level, msg: R(e.msg, CAP.msg) ?? "", route: R(e.route, 200), status: Number.isInteger(e.status) ? Number(e.status) : null,
    stack: R(e.stack, CAP.stack), request_id: e.request_id && /^[A-Za-z0-9_.:-]{4,64}$/.test(String(e.request_id)) ? String(e.request_id) : null,
    runner: e.runner && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(String(e.runner)) ? String(e.runner) : null };
}
// store entries (already from a trusted path: the front door, a Space, the runner op), then trim each touched source to its caps
export function put(sql: Sql, entries: Entry[], known: string[] = []) {
  const touched = new Set<string>(); let n = 0;
  for (const raw of entries.slice(0, CAP.batch)) { const e = clean(raw, known); if (!e.msg && !e.stack) continue;
    sql.exec("insert into devlog(ts, source, level, msg, route, status, stack, rid, runner) values(?,?,?,?,?,?,?,?,?)", e.ts, e.source, e.level, e.msg, e.route, e.status, e.stack, e.request_id, e.runner);
    touched.add(e.source); n++; }
  for (const s of touched) { // rotation: the ring keeps the newest per source, errors counted apart so a chatty log can't push them out
    sql.exec("delete from devlog where source=? and level='error' and id not in (select id from devlog where source=? and level='error' order by id desc limit ?)", s, s, CAP.errors);
    sql.exec("delete from devlog where source=? and level!='error' and id not in (select id from devlog where source=? and level!='error' order by id desc limit ?)", s, s, CAP.lines);
  }
  return { stored: n };
}
// since: ms epoch, an ISO time, or "15m" / "2h" / "3d" ago
export function sinceMs(v: any, now = Date.now()): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+$/.test(String(v))) { const n = Number(v); return n < 1e11 ? n * 1000 : n; } // seconds or ms epoch
  const m = String(v).match(/^(\d+)\s*([smhd])$/); if (m) return now - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s"];
  const t = Date.parse(String(v)); if (Number.isFinite(t)) return t;
  throw new Error("since: a time (ISO or ms epoch) or an age like 15m, 2h, 3d");
}
export function read(sql: Sql, q: { source?: string; since?: any; level?: string; limit?: number; request_id?: string } = {}) {
  const where: string[] = [], args: any[] = [];
  if (q.source && q.source !== "all") { if (!(SOURCES as readonly string[]).includes(q.source)) throw new Error("source: " + [...SOURCES, "all"].join(" | ")); where.push("source=?"); args.push(q.source); }
  if (q.level) { const i = (LEVELS as readonly string[]).indexOf(q.level); if (i < 0) throw new Error("level: " + LEVELS.join(" | ") + " (that level and above)"); const ok = LEVELS.slice(i); where.push(`level in (${ok.map(() => "?").join(",")})`); args.push(...ok); }
  const s = sinceMs(q.since); if (s != null) { where.push("ts>=?"); args.push(s); }
  if (q.request_id) { where.push("rid=?"); args.push(String(q.request_id)); }
  const lim = Math.min(500, Math.max(1, Number(q.limit) || 100));
  const rows = sql.exec(`select * from devlog ${where.length ? "where " + where.join(" and ") : ""} order by id desc limit ?`, ...args, lim).toArray();
  return rows.map((r: any) => ({ id: r.id, at: new Date(r.ts).toISOString(), source: r.source, level: r.level, msg: r.msg, ...(r.route ? { route: r.route } : {}), ...(r.status != null ? { status: r.status } : {}),
    ...(r.stack ? { stack: r.stack } : {}), ...(r.rid ? { request_id: r.rid } : {}), ...(r.runner ? { runner: r.runner } : {}) }));
}
export function counts(sql: Sql) {
  return Object.fromEntries((sql.exec("select source, sum(level='error') e, count(*) n from devlog group by source").toArray() as any[]).map(r => [r.source, { errors: Number(r.e), total: Number(r.n) }]));
}
// an unhandled exception as an entry (the message's first line, the stack without it)
export function fromError(e: any, x: { source?: string; route?: string; status?: number; request_id?: string }): Entry {
  const msg = String(e?.message ?? e ?? "error"), stack = typeof e?.stack === "string" ? e.stack : null;
  return { level: "error", source: x.source ?? "server", msg: (e?.name && e.name !== "Error" ? e.name + ": " : "") + msg, stack, route: x.route ?? null, status: x.status ?? 500, request_id: x.request_id ?? null };
}
