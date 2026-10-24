// Experimental's recent logs/errors: the shared log redactor (client/redact.ts redactLog), the server's ring (src/devlog.ts on bun:sqlite, same
// SQL as the Dir), who may read it (op relay_logs on a fake Space), and the Mac's ring file (client/devlog.ts). Run: bun test client/devlog.test.ts
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { redactLog } from "./redact.ts";
import * as DL from "../src/devlog.ts";
import { peerOps } from "../src/space/peers.ts";
import { Ring, classify, CAP as RCAP, ringFile, logsCli, knownSecrets } from "./devlog.ts";

const sqlOf = (db: Database) => ({ exec: (q: string, ...a: any[]) => { const st = db.query(q), rows = /^\s*select/i.test(q) ? st.all(...a) : (st.run(...a), []); return { toArray: () => rows }; } });
function ring() { const db = new Database(":memory:"); for (const q of DL.DEVLOG_SCHEMA.split(";").filter(x => x.trim())) db.run(q); return { db, sql: sqlOf(db) }; }

test("redactLog: headers, bearer, cookies, query tokens, Kitebook tokens, known values, emails", () => {
  const s = [
    "Authorization: Bearer abcdefghijklmnop1234", "cookie: better-auth.session_token=s3cr3tvalue.sig; other=1", "set-cookie: relay-erin=zzzzzzzzzzzzzzzz; Path=/",
    "GET /mcp?token=rk.erin.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&x=1", "oauth at.erin.BBBBBBBBBBBBBBBBBBBBBBBB done", "github ghp_" + "c".repeat(36),
    "BETTER_AUTH_SECRET=aB3dE5fG7hJ9kL1mN2pQ4rS6", "password: hunter2!", "the env value MyServerSecretValue42 leaked", "mail me at alice@example.com", "invite inv_erin.abcdefghijklmnop",
  ].join("\n");
  const r = redactLog(s, ["MyServerSecretValue42"]);
  for (const bad of ["abcdefghijklmnop1234", "s3cr3tvalue", "zzzzzzzzzzzzzzzz", "rk.erin.AAAA", "at.erin.BBBB", "ghp_ccc", "aB3dE5fG7hJ9", "hunter2", "MyServerSecretValue42", "alice@example.com", "inv_erin.abc"]) expect(r).not.toContain(bad);
  expect(r).toContain("[REDACTED]"); expect(r).toContain("[EMAIL]");
  expect(redactLog("alice@example.com", [], { emails: false })).toBe("alice@example.com");
  expect(redactLog("TypeError: Cannot read properties of undefined (reading 'origin') at ba (auth.ts:120)")).toBe("TypeError: Cannot read properties of undefined (reading 'origin') at ba (auth.ts:120)"); // ordinary errors untouched
});

test("server ring: stores redacted, caps per source with errors kept apart, filters", () => {
  const { sql } = ring(), env = { ADMIN_TOKEN: "admintoken-1234567890", BETTER_AUTH_SECRET: "ba-secret-abcdefghijkl", HOSTED: "1", PUBLIC_URL: "https://x.example" };
  expect(DL.envSecrets(env).sort()).toEqual(["admintoken-1234567890", "ba-secret-abcdefghijkl"]);
  DL.put(sql, [DL.fromError(new Error("boom with admintoken-1234567890 inside"), { source: "auth", route: "POST /api/auth/sign-in/passkey", request_id: "req_0123456789abcdef" })], DL.envSecrets(env));
  const [e] = DL.read(sql, { request_id: "req_0123456789abcdef" });
  expect(e.msg).toBe("boom with [REDACTED] inside"); expect(e.source).toBe("auth"); expect(e.status).toBe(500); expect(e.route).toBe("POST /api/auth/sign-in/passkey"); expect(e.stack).toContain("devlog.test.ts");
  const many: DL.Entry[] = []; for (let i = 0; i < 650; i++) many.push({ source: "server", level: "info", msg: "line " + i }); for (let i = 0; i < 260; i++) many.push({ source: "server", level: "error", msg: "err " + i });
  for (let i = 0; i < many.length; i += DL.CAP.batch) DL.put(sql, many.slice(i, i + DL.CAP.batch));
  expect(DL.counts(sql).server).toEqual({ errors: DL.CAP.errors, total: DL.CAP.errors + DL.CAP.lines });
  expect(DL.read(sql, { source: "server", level: "error", limit: 1 })[0].msg).toBe("err 259"); // newest first
  expect(DL.read(sql, { source: "server", level: "info", limit: 500 }).length).toBe(500); // info and above
  expect(DL.read(sql, { source: "auth" }).length).toBe(1);
  expect(DL.read(sql, { since: "1h", limit: 5 }).length).toBe(5); expect(DL.read(sql, { since: Date.now() + 3600_000 }).length).toBe(0);
  expect(() => DL.read(sql, { source: "nope" })).toThrow("source:"); expect(() => DL.read(sql, { level: "loud" })).toThrow("level:"); expect(() => DL.read(sql, { since: "yesterday-ish" })).toThrow("since:");
  const c = DL.clean({ source: "weird", level: "shout", msg: "x".repeat(5000), request_id: "bad id with spaces", runner: "Mac!" });
  expect([c.source, c.level, c.msg.length, c.request_id, c.runner]).toEqual(["server", "info", DL.CAP.msg + 1, null, null]);
});

test("relay_logs: the runner always; an own app with dispatch only while Experimental is on; never a person", async () => {
  const { sql } = ring(); DL.put(sql, [{ source: "server", level: "error", msg: "kaput", request_id: "req_aaaaaaaaaaaaaaaa", status: 500, route: "op ls" }]);
  let dev: any = null, sender: any = { connected: true, own: true }, needed: string[] = [];
  const sp: any = { experimentalState: () => dev, senderState: async () => sender, need: (_p: any, v: string) => { needed.push(v); },
    dirOf: () => ({ devlogRead: async (q: any) => ({ entries: DL.read(sql, q), counts: DL.counts(sql) }), devlogPut: async (e: any[]) => DL.put(sql, e) }) };
  const ops: any = peerOps.call(sp), app = { id: "p1", name: "hark", kind: "assistant" }, mac = { id: "p2", name: "imac", kind: "runner" };
  await expect(ops.relay_logs(app, {})).rejects.toThrow("needs_owner");
  expect((await ops.relay_logs(mac, { level: "error" })).entries[0].request_id).toBe("req_aaaaaaaaaaaaaaaa");
  expect((await ops.logs_report(mac, { entries: [{ msg: "x" }] })).stored).toBe(0); // Experimental off: the Mac keeps them
  dev = { on: true, ci: true, gh_status: false };
  const r = await ops.relay_logs(app, { source: "server", level: "error" }); expect(r.experimental).toBe(true); expect(r.dev).toBe(true); expect(r.entries[0].msg).toBe("kaput"); expect(needed).toContain("dispatch");
  await expect(ops.relay_logs(app, { source: "bogus" })).rejects.toThrow("source:");
  sender = { connected: true, own: false, why: "a person, not one of your apps" }; await expect(ops.relay_logs({ id: "p3", name: "dana", kind: "human" }, {})).rejects.toThrow("forbidden");
  await expect(ops.logs_report(app, { entries: [] })).rejects.toThrow("runners only");
  expect((await ops.logs_report(mac, { entries: [{ level: "error", source: "updates", msg: "update failed: token ghp_" + "d".repeat(36) }, { msg: "hi", source: "server" }] })).stored).toBe(2);
  const up = DL.read(sql, { source: "updates" })[0]; expect(up.runner).toBe("imac"); expect(up.msg).not.toContain("ghp_");
  expect(DL.read(sql, { source: "runner" })[0].msg).toBe("hi"); // a runner can't write into the server's sources
});

test("Mac ring: redacted on disk, classified, compacted to its caps, cursor-able; kitebook logs --errors reads it", async () => {
  const home = mkdtempSync(join(tmpdir(), "devlog-")), r = new Ring(ringFile(home), () => ["runnerTOKENvalue123"]);
  try {
    expect(classify("installed release v3 (was v2)").source).toBe("updates"); expect(classify("task x failed: boom").level).toBe("error"); expect(classify("connected as imac")).toEqual({ level: "info", source: "runner" });
    const a = r.add("info", "connected with runnerTOKENvalue123 and Bearer abcdefghijklmnopqrstu")!; expect(a.msg).not.toContain("runnerTOKENvalue123"); expect(a.msg).not.toContain("abcdefghijklmnopqrstu");
    expect(readFileSync(ringFile(home), "utf8")).not.toContain("runnerTOKENvalue123");
    expect(statSync(ringFile(home)).mode & 0o077).toBe(0);
    for (let i = 0; i < 700; i++) r.add("info", "tick " + i); for (let i = 0; i < 230; i++) r.add("error", "bad " + i, "Error: bad\n    at x (y.ts:1)");
    r.compact(); const all = r.all();
    expect(all.filter(e => e.level === "error").length).toBe(RCAP.errors); expect(all.filter(e => e.level !== "error").length).toBe(RCAP.lines);
    expect(all[all.length - 1].msg).toBe("bad 229"); expect(r.after(all[all.length - 2].n).length).toBe(1);
    const out: string[] = [], log = console.log; console.log = (...x: any[]) => out.push(x.join(" "));
    try { expect(await logsCli({}, ["--errors", "-n", "3"], home)).toBe(0); } finally { console.log = log; }
    expect(out.filter(l => l.includes(" error ")).length).toBe(3); expect(out.join("\n")).toContain("bad 229"); expect(out.join("\n")).toContain("at x (y.ts:1)");
    expect(knownSecrets({ token: "rk.erin." + "z".repeat(32), ntfy: { token: "tk_abcdefgh" } })).toContain("tk_abcdefgh");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
