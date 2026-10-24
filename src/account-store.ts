// What an account's Dir keeps about the account itself, beyond its peers and spaces: its users, an audit trail and usage counters.
// Pure SQL on the Dir's storage (d.sql), so client/account-store.test.ts runs it on bun:sqlite. Groundwork for Teams and a hosted
// Kitebook (research/auth-selfhosted-to-hosted.md, "Design choices to make now"); a single-owner self-host behaves exactly as before.
//
//   users   id, role, created     the people in this account. Today exactly one, the owner (id OWNER_USER = the "tenant" every
//                                 device / session / passkey / presence row already carries), added by a migration that changes nothing
//                                 else, so an existing install keeps working untouched. Teams adds members here, not a second scheme.
//   audit   seq, ts, actor, action, target, ok    append-only: who changed what in this account (admin commands, account events).
//                                 Never a secret: the target is a name or id (peer, app, space, device), cleaned and capped; nothing
//                                 is updated in place, and only the oldest rows past AUDIT_KEEP are trimmed.
//   usage   day, metric, n        per-day counters (UTC day): requests (authenticated API/MCP calls), admin (admin commands). Billing
//                                 and per-account limits later need history, so it starts counting now; days past USAGE_DAYS are dropped.
import { OWNER_USER, ROLES, type Role, type User } from "../client/account.ts";

export const ACCOUNT_SCHEMA = `
create table if not exists users(id text primary key, role text not null, created text);
create table if not exists audit(seq integer primary key autoincrement, ts integer, actor text, action text, target text, ok integer default 1);
create table if not exists usage(day text, metric text, n integer default 0, primary key(day, metric));`;
export const AUDIT_KEEP = 10_000, USAGE_DAYS = 400;
export const METRICS = ["requests", "admin"] as const;
export type Metric = typeof METRICS[number];

type D = { acct: string; sql: SqlStorage };
const clean = (s: any, n = 80) => String(s ?? "").replace(/[^\w.:@/+-]/g, "").slice(0, n);
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
// admin commands that only read: not audit-worthy (export is a read too, but it hands out the whole space, so it is kept)
export const AUDIT_SKIP = new Set(["list", "status", "presence", "task", "brief", "policy", "expiries", "grants", "usage", "connection", "devices", "tunnel_report", "audit", "users"]);
// the one name or id an admin command acts on, never its secrets (keys, tokens, envelopes, dumps)
export const auditTarget = (a: any) => { for (const k of ["peer", "app", "agent", "space", "id", "account", "name", "task"]) if (a?.[k] != null && a[k] !== "") return clean(a[k]); return ""; };

export const accountFns = {
  // the migration: every account gets its owner user. Idempotent and additive, so an existing install is a no-op apart from this row.
  ensureOwner(d: D) {
    const created = (d.sql.exec("select v from acct where k='created'").toArray()[0] as any)?.v ?? null;
    d.sql.exec("insert or ignore into users(id, role, created) values(?, 'owner', ?)", OWNER_USER, created);
  },
  users(d: D): User[] {
    return (d.sql.exec("select id, role, created from users order by created is null desc, created, id").toArray() as any[])
      .map(r => ({ id: r.id, account: d.acct, role: (ROLES.includes(r.role) ? r.role : "viewer") as Role, created: r.created ?? null }));
  },
  user(d: D, id: string = OWNER_USER): User | null { return accountFns.users(d).find(u => u.id === id) ?? null; },
  audit(d: D, actor: string, action: string, target = "", ok = true) {
    try {
      const r = d.sql.exec("insert into audit(ts, actor, action, target, ok) values(?,?,?,?,?) returning seq", Date.now(), clean(actor, 60) || "unknown", clean(action, 60), clean(target), ok ? 1 : 0).toArray()[0] as any;
      if (r && Number(r.seq) % 100 === 0) d.sql.exec("delete from audit where seq <= ?", Number(r.seq) - AUDIT_KEEP);
    } catch (e) { console.error("audit", e); } // the trail never breaks the action it records
  },
  auditList(d: D, a: { limit?: number; before?: number } = {}) {
    const lim = Math.max(1, Math.min(Number(a.limit) || 100, 1000)), before = Number(a.before) > 0 ? Number(a.before) : Number.MAX_SAFE_INTEGER;
    return (d.sql.exec("select seq, ts, actor, action, target, ok from audit where seq < ? order by seq desc limit ?", before, lim).toArray() as any[])
      .map(r => ({ seq: Number(r.seq), at: new Date(Number(r.ts)).toISOString(), actor: r.actor, action: r.action, target: r.target || null, ok: !!r.ok }));
  },
  meter(d: D, metric: Metric, n = 1) {
    try {
      const r = d.sql.exec("insert into usage(day, metric, n) values(?,?,?) on conflict(day, metric) do update set n = n + excluded.n returning n", day(), metric, n).toArray()[0] as any;
      if (r && Number(r.n) === n) d.sql.exec("delete from usage where day < ?", day(Date.now() - USAGE_DAYS * 86400_000)); // this metric's first count today: drop old days
    } catch (e) { console.error("meter", e); }
  },
  counters(d: D, days = 30) {
    const rows = d.sql.exec("select day, metric, n from usage where day >= ? order by day", day(Date.now() - (Math.max(1, Math.min(days, USAGE_DAYS)) - 1) * 86400_000)).toArray() as any[];
    const by: Record<string, Record<string, number>> = {}, total: Record<string, number> = {};
    for (const r of rows) { (by[r.day] ??= {})[r.metric] = Number(r.n); total[r.metric] = (total[r.metric] ?? 0) + Number(r.n); }
    return { days: Object.entries(by).map(([d, m]) => ({ day: d, ...m })), total };
  },
};
