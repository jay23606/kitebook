// Immutable OAuth credential -> grant bindings. Never resolve an issued credential by an app name or its newest grant.
// Codes and refresh tokens carry the binding through rotation; pre-migration credentials fail closed and must sign in again.
import { sha256 } from "./ops.ts";
export class GrantTokens {
  constructor(private sql: { exec(query: string, ...args: any[]): { toArray(): any[] } }) {
    sql.exec("create table if not exists oauth_bound_tokens(hash text primary key, family text not null, expires integer not null)");
  }
  async keep(kind: "code" | "refresh" | "access", token: string, family: string, expires: number) {
    if (!token || !Number.isFinite(expires) || expires <= Date.now()) throw new Error("invalid OAuth credential binding");
    const hash = await sha256(kind + ":" + token);
    // insert, never replace: one credential can never migrate to another grant.
    this.sql.exec("insert or ignore into oauth_bound_tokens values(?,?,?)", hash, family, expires);
    this.sql.exec("delete from oauth_bound_tokens where expires<=?", Date.now() - 86400_000);
  }
  async get(kind: "code" | "refresh" | "access", token: string, allowExpired = false): Promise<{ id: string; client_id: string } | null> {
    if (!token) return null;
    return this.sql.exec("select f.id, f.client_id from oauth_bound_tokens t join oauth_families f on f.id=t.family join peers p on p.id=f.peer_id where t.hash=? and (t.expires>? or ?=1) and f.source='consent' and f.revoked=0 and p.revoked=0 and (p.expires is null or p.expires>?)", await sha256(kind + ":" + token), Date.now(), allowExpired ? 1 : 0, Date.now()).toArray()[0] as { id: string; client_id: string } ?? null;
  }
}
