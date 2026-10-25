import { test, expect, beforeAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { OAUTH_FNS as O, OAUTH_SCHEMA, knobs } from "../src/oauth.ts";
import { passwordLogin } from "../src/browser-login.ts";
import { DEVICE_SCHEMA, deviceFns as F } from "../src/devices.ts";
import { remoteAnswer, RemoteLimiter } from "./remote-presence.ts";

const PW = "browser fixture password 42";
beforeAll(() => { process.env.HOME = mkdtempSync(join(tmpdir(), "kb-login-")); process.env.KITEBOOK_TEST = "1"; process.env.KITEBOOK_KEYSTORE = "file"; });
function dir() {
  const db = new Database(":memory:");
  for (const q of ("create table acct(k text primary key,v text);create table spaces(id text primary key);" + OAUTH_SCHEMA + DEVICE_SCHEMA).split(";").filter(x => x.trim())) db.run(q);
  db.run("insert into spaces values('main')");
  const d: any = { acct: "root", db, sql: { exec(q: string, ...a: any[]) { const st = db.query(q); if (/^\s*select|returning/i.test(q)) { const rows = st.all(...a); return { toArray: () => rows, one: () => rows[0] }; } st.run(...a); return { toArray: () => [] }; } } };
  d.oauth = (op: string, ...a: any[]) => O[op](d, ...a); d.dev = (op: string, ...a: any[]) => F[op](d, ...a); return d;
}

test("phone sign-in: password verified by the Mac, bound to the browser request, consumed once", async () => {
  const d = dir(), P = await import("./password.ts"), DV = await import("./device.ts"), K = await import("./keystore.ts");
  const wrapped = await P.wrapNew(PW, "terminal"); P.commit("browser-login", wrapped.file);
  d.db.query("insert into devices(id,name,pubkey,password_key,peer,state,created) values('dv_login','mac','p256:unused',?,'mac','active',1)").run(wrapped.pub);
  const s: any = { slot: "browser-login", account: "root", id: "dv_login", state: "active" }, audit: any[] = [], limiter = new RemoteLimiter(); let relays = 0;
  d.rpw = async (_op: string, q: any) => { relays++; const r = await remoteAnswer(q, { enabled: true, hasPassword: true, limiter, audit: e => audit.push(e), assert: (action, sign) => DV.assertWith(s, action, sign), unlockSign: async (pw, msg) => K.signWith(P.unlock(s.slot, pw), msg) }); return { ...r, peer: "mac", status: 401 }; };
  const a = await O.loginNew(d, { label: "Phone" }, knobs({})), b = await O.loginNew(d, { label: "Other" }, knobs({}));
  await expect(passwordLogin(d, a.code, PW)).rejects.toThrow(/expired or was already answered/); expect(relays).toBe(0);
  expect(await passwordLogin(d, a.poll, "wrong")).toMatchObject({ ok: false });
  expect(O.connectGet(d, a.id).status).toBe("pending");
  expect(await passwordLogin(d, a.poll, PW)).toMatchObject({ ok: true });
  expect(O.connectGet(d, b.id).status).toBe("pending");
  expect(await O.connectPoll(d, { poll: a.poll, client_id: "login", redirect_uri: "", challenge: "" })).toMatchObject({ state: "approved", login: true });
  await expect(O.connectPoll(d, { poll: a.poll, client_id: "login", redirect_uri: "", challenge: "" })).rejects.toThrow(/already used/);
  const previous = relays; await expect(passwordLogin(d, a.poll, PW)).rejects.toThrow(/already answered/); expect(relays).toBe(previous);
  expect(JSON.stringify(audit)).not.toContain(PW); expect(JSON.stringify(d.db.query("select * from acct").all())).not.toContain(PW);
  d.db.query("update oauth_connect set expires=? where id=?").run(Date.now() - 1, b.id);
  await expect(passwordLogin(d, b.poll, PW)).rejects.toThrow(/expired/); expect(relays).toBe(previous);
});

test("phone sign-in fails closed for relay off/offline/locked, bad proof, or a decision made during the password check", async () => {
  for (const status of [403, 503, 429]) { const d = dir(), a = await O.loginNew(d, { label: "Phone" }, knobs({}));
    d.rpw = async () => ({ ok: false, status, error: "unavailable" });
    expect(await passwordLogin(d, a.poll, PW)).toMatchObject({ ok: false, status }); expect(O.connectGet(d, a.id).status).toBe("pending"); }
  const d = dir(), a = await O.loginNew(d, { label: "Phone" }, knobs({}));
  d.rpw = async () => ({ ok: true, presence: "forged", peer: "mac" });
  expect(await passwordLogin(d, a.poll, PW)).toMatchObject({ ok: false, status: 401 });
  d.rpw = async () => { await O.loginDecide(d, a.id, false); return { ok: true, presence: "fixture", peer: "mac" }; }; d.dev = async () => ({ ok: true });
  await expect(passwordLogin(d, a.poll, PW)).rejects.toThrow(/already answered/); expect(O.connectGet(d, a.id).status).toBe("denied");
});

test("browser codes resolve on the server without local ask files; ambiguous codes are refused", async () => {
  const d = dir(), a = await O.loginNew(d, { label: "Phone" }, knobs({}));
  expect(O.connectGet(d, a.code.toLowerCase())).toMatchObject({ id: a.id, kind: "login", nonce: expect.any(String) });
  const b = await O.loginNew(d, { label: "Other" }, knobs({})); d.db.query("update oauth_connect set code=? where id=?").run(a.code, b.id);
  expect(() => O.connectGet(d, a.code)).toThrow(/More than one/);
});

test("CLI missing local ask: resolves browser code before prompting; never falls back on network failure or expiry, no means no", async () => {
  const DV = await import("./device.ts"), P = await import("./password.ts"); P.commit("login-cli", (await P.wrapNew(PW, "terminal")).file);
  const privateDir = join(homedir(), ".kitebook"); mkdirSync(privateDir, { recursive: true });
  writeFileSync(join(privateDir, "device-login-cli.json"), JSON.stringify({ slot: "login-cli", account: "root", id: "dv_cli", state: "active", shortcut: false }));
  process.env.KITEBOOK_TEST_PASSWORD = PW;
  let status = "pending", fail = false, decisions: any[] = [], paths: string[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) { const path = new URL(req.url).pathname; paths.push(path);
    if (path === "/v1/connect_get") return Response.json(fail ? { ok: false, error: "temporary failure" } : { ok: true, result: { id: "cr_0123456789abcdef", status, nonce: "nonce", code: "BCDF-GHJK", app: "Phone" } });
    if (path === "/v1/connect_decide") { decisions.push(await req.json()); return Response.json({ ok: true, result: {} }); }
    return Response.json({ ok: false, error: "wrong endpoint" }); } });
  try { const c = { url: server.url.toString().replace(/\/$/, ""), token: "fixture", name: "login-cli" };
    expect(await DV.codeApprove(c, "bcdf-ghjk")).toBe(0); expect(decisions[0]).toMatchObject({ id: "cr_0123456789abcdef", yes: true, presence: expect.any(String) });
    expect(await DV.codeApprove(c, "BCDF-GHJK", false)).toBe(0); expect(decisions[1]).toMatchObject({ yes: false }); expect(decisions[1].presence).toBeUndefined();
    status = "expired"; expect(await DV.codeApprove(c, "BCDF-GHJK")).toBe(1); fail = true; expect(await DV.codeApprove(c, "BCDF-GHJK")).toBe(1);
    expect(decisions.length).toBe(2); expect(paths).not.toContain("/device");
  } finally { server.stop(true); delete process.env.KITEBOOK_TEST_PASSWORD; }
});
