import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { GrantTokens } from "../src/auth-grants.ts";
function fixture() {
  const db = new Database(":memory:");
  db.exec("create table peers(id text primary key, revoked integer, expires integer); create table oauth_families(id text primary key, client_id text, peer_id text, source text, revoked integer, created text)");
  db.exec("insert into peers values('p',0,null),('p2',0,null); insert into oauth_families values('old','client','p','consent',0,'1'),('new','client','p2','consent',0,'2')");
  const sql = { exec(q: string, ...args: any[]) { const s = db.prepare(q); return { toArray: () => s.all(...args) }; } } as any;
  // DO exec executes immediately; the fixture's wrapper must do the same for writes.
  sql.exec = (q: string, ...args: any[]) => { const s = db.prepare(q); if (/^select/i.test(q)) return { toArray: () => s.all(...args) }; s.run(...args); return { toArray: () => [] }; };
  return { db, bound: new GrantTokens(sql) };
}
test("revocation is permanent across reconnects, including wider replacement grants", async () => {
  const { db, bound } = fixture(); const expires = Date.now() + 60000;
  await bound.keep("access", "old-token", "old", expires); await bound.keep("refresh", "old-refresh", "old", expires);
  expect((await bound.get("access", "old-token"))?.id).toBe("old");
  db.exec("update oauth_families set revoked=1 where id='old'");
  await bound.keep("access", "new-token", "new", expires);
  expect(await bound.get("access", "old-token")).toBeNull(); expect(await bound.get("refresh", "old-refresh")).toBeNull();
  expect((await bound.get("access", "new-token"))?.id).toBe("new");
  expect(await bound.get("access", "unbound-legacy-token")).toBeNull(); db.close();
});
test("code exchanges and rotated refresh tokens keep their issuing grant", async () => {
  const { db, bound } = fixture(), expires = Date.now() + 60000;
  await bound.keep("code", "code", "old", expires); await bound.keep("code", "code", "new", expires);
  const issued = await bound.get("code", "code"); expect(issued?.id).toBe("old");
  await bound.keep("refresh", "rotation", issued!.id, expires); expect((await bound.get("refresh", "rotation"))?.id).toBe("old");
  expect(await bound.get("access", "rotation")).toBeNull();
  db.exec("update peers set revoked=1 where id='p'"); expect(await bound.get("refresh", "rotation")).toBeNull(); db.close();
});
test("expired credentials are rejected; diagnostics still distinguish a removed grant", async () => {
  const { db, bound } = fixture(); await bound.keep("access", "token", "old", Date.now() + 60000);
  db.exec("update oauth_bound_tokens set expires=1"); expect(await bound.get("access", "token")).toBeNull();
  expect((await bound.get("access", "token", true))?.id).toBe("old");
  db.exec("update peers set expires=1 where id='p'"); expect(await bound.get("access", "token", true)).toBeNull(); db.close();
});
