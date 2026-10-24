// An app's relay_update on a git install (client/settings-sync.ts devAsk / devPending; owner, 2026-10-22 22:00: "update is fine, just remove
// those barriers except it could only pull from latest"): the RUNNER handles it (no task, no coding agent), with no confirm code, presence
// prompt, Experimental or standing switch, and moves only to the newest commit of its channel, resolved again right before the move: a
// fast-forward, never back, rolled back if the new code fails its check. Asks and approvals left over from the old flow are migrated.
// The runner side runs in a child process with its own HOME (asks, audit) and a launchctl stand-in (no services here).
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, rmSync, chmodSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const T = mkdtempSync(join(tmpdir(), "kitebook-nogate-"));
const git = (d: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode) throw new Error(`git ${a.join(" ")}: ${p.stderr}`); return p.stdout.toString().trim(); };
const commit = (d: string, msg: string) => { appendFileSync(join(d, "f"), msg + "\n"); git(d, "add", "-A"); git(d, "commit", "-qm", msg); return git(d, "rev-parse", "HEAD"); };
const env = (H: string, extra: Record<string, string> = {}) => ({ ...process.env, HOME: H, KITEBOOK_TEST: "1", KITEBOOK_KEYSTORE: "file", KITEBOOK_TASK_ID: "", KITEBOOK_GIT_WATCH: "off", KITEBOOK_PRESENCE: "", ...extra });
function child(H: string, code: string) {
  const p = Bun.spawnSync([process.execPath, "-e", code], { env: env(H), stdout: "pipe", stderr: "pipe", timeout: 90_000 });
  const l = p.stdout.toString().split("\n").reverse().find(x => x.startsWith("RESULT ")); if (!l) throw new Error(p.stdout.toString() + p.stderr.toString()); return JSON.parse(l.slice(7));
}
const D = JSON.stringify(import.meta.dir);

// one settings-sync pass with an owner-signed policy (Experimental on or off), asks from hark (may send tasks), the server confirming hark is the owner's app
function runnerPass(d: string, mac: string, H: string, lc: string, cfg: string, dev: boolean) {
  return (reqs: string[], tag: string, o: { idle?: boolean; cmds?: any[]; auth?: boolean } = {}) => child(H, `const SS = await import(${D} + "/settings-sync.ts"), { canon, cmdMsg } = await import(${D} + "/payload.ts"), fs = require("fs");
    const st = ${JSON.stringify(join(d, "owner.json"))}; let o; if (fs.existsSync(st)) o = JSON.parse(fs.readFileSync(st, "utf8")); else {
      const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]); o = { pub: "p256:" + Buffer.from(await crypto.subtle.exportKey("spki", kp.publicKey)).toString("base64url"), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) }; fs.writeFileSync(st, JSON.stringify(o)); }
    const cfgPath = ${JSON.stringify(cfg)}; if (!fs.existsSync(cfgPath)) fs.writeFileSync(cfgPath, JSON.stringify({ url: "http://127.0.0.1:9", token: "rk.x", space: "main", name: "imac", source: ${JSON.stringify(mac)}, launchctl: ${JSON.stringify(lc)}, ownerKeys: [o.pub] }), { mode: 0o600 });
    const pol = { v: 1, type: "relay-policy", space: "main", seq: 1, at: 1, apps: {}, ${dev ? `experimental: { on: true }` : ""} };
    const priv = await crypto.subtle.importKey("jwk", o.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    const envelope = { policy: pol, key: o.pub, sig: Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode("relay-policy:v1|" + canon(pol)))).toString("base64url") };
    const cmds = []; for (const m of ${JSON.stringify(o.cmds ?? [])}) { const cmd = { v: 1, type: "relay-owner-cmd", space: "main", at: Date.now(), runner: "imac", ...m };
      cmds.push({ cmd, key: o.pub, sig: Buffer.from(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, new TextEncoder().encode(cmdMsg(cmd)))).toString("base64url") }); }
    const calls = [], logs = [], audits = [];
    const call = async (op, a = {}) => { calls.push(op + (a.from ? ":" + a.from : "")); if (op === "policy" && a.from) return { sender: { connected: true, own: true } };
      if (op === "policy") return { envelope, owner_keys: [], cmds, update_requests: ${JSON.stringify(reqs)}.map(id => ({ id, by: "hark", at: 1, ...(${JSON.stringify(o.auth ?? false)} ? { auth: true } : { dev: true }) })) };
      if (op === "settings_report") { calls.push("report " + JSON.stringify(a.settings)); return { ok: true }; } return {}; };
    await SS.syncOnce({ cfgPath, name: "imac", space: "main", call, log: (...a) => logs.push(a.join(" ")), audit: e => audits.push(e), stamp: () => {}, darwin: false, idle: () => ${o.idle !== false} });
    const rep = JSON.parse(calls.filter(c => c.startsWith("report ")).pop()?.slice(7) ?? "null");
    console.log("RESULT " + JSON.stringify({ tag: ${JSON.stringify(tag)}, calls: calls.filter(c => !c.startsWith("report ")), logs, audits: audits.map(e => e.type), auditsFull: audits, pending: rep?.update?.pending ?? null, nogate: rep?.update?.nogate ?? null, trust: rep?.update?.trust ?? null, done: rep?.done ?? [], history: rep?.update?.history ?? [] }));`);
}
function setup(name: string) {
  const d = join(T, name), up = join(d, "up"), mac = join(d, "mac"), H = join(d, "home"), lc = join(d, "launchctl"), cfg = join(d, "runner.json");
  Bun.spawnSync(["git", "init", "-q", "--bare", join(d, "origin.git")]); Bun.spawnSync(["git", "clone", "-q", join(d, "origin.git"), up], { stderr: "pipe" });
  const A = commit(up, "a"); git(up, "push", "-q", "origin", "HEAD:main", "HEAD:dev"); Bun.spawnSync(["git", "clone", "-q", "-b", "main", join(d, "origin.git"), mac], { stderr: "pipe" });
  writeFileSync(lc, "#!/bin/sh\nexit 1\n"); chmodSync(lc, 0o755); mkdirSync(H, { recursive: true });
  return { d, up, mac, H, lc, cfg, A, head: () => git(mac, "rev-parse", "HEAD") };
}
const id = (n: number) => "ur_00000000000000" + n.toString(16).padStart(2, "0");

test("Experimental on: an app's ask installs the newest origin/dev right away (no code, no confirm, no task); a busy runner waits, then installs the newest commit THEN, not the one at ask time", () => {
  const { d, up, mac, H, lc, cfg, A, head } = setup("devon");
  const B = commit(up, "b"); git(up, "push", "-q", "origin", "HEAD:dev");
  const pass = runnerPass(d, mac, H, lc, cfg, true);
  let r = pass([id(1)], "ask");
  expect(head()).toBe(B); expect(r.nogate).toBe(true); expect(r.pending ?? []).toEqual([]);
  const d1 = r.done.find((x: any) => x.id === id(1)); expect(d1).toMatchObject({ do: "relay_update", ok: true, state: "updated", sha: B, to: B.slice(0, 7), from: A.slice(0, 7), health: "ok", approved_by: "app" });
  expect(d1.msg).toMatch(new RegExp(`^Updated by hark to ${B.slice(0, 7)} .*health ok`)); expect(d1.code).toBeUndefined();
  expect(r.history[0]).toMatchObject({ result: "installed", by: "hark (relay_update)", to: B.slice(0, 7) });
  expect(r.calls.every((c: string) => ["policy", "policy:hark", "settings_report"].includes(c))).toBe(true); // the runner itself: no task_create, nothing dispatched
  expect(r.audits).toEqual(expect.arrayContaining(["update_ask", "update_dev", "update"])); expect(r.logs.join("\n")).not.toMatch(/kitebook confirm/);
  expect(r.auditsFull.find((e: any) => e.type === "update_dev").approved_by).toBe("app (Let apps update Kitebook)");
  expect(JSON.parse(readFileSync(cfg, "utf8")).updatePin).toBeUndefined();
  // busy: the ask waits (no code, approved by the app's ask), nothing moves; origin/dev moves on meanwhile; once idle it installs the newest (D, not C)
  const C = commit(up, "c"); git(up, "push", "-q", "origin", "HEAD:dev");
  r = pass([id(1), id(2)], "busy", { idle: false }); expect(head()).toBe(B);
  expect(r.pending).toHaveLength(1); expect(r.pending[0]).toMatchObject({ kind: "dev", id: id(2), sha: C, ref: "dev", approved: { by: "app" } }); expect(r.pending[0].code).toBeUndefined(); expect(r.pending[0].why).toMatch(/no confirmation needed/);
  const D2 = commit(up, "d"); git(up, "push", "-q", "origin", "HEAD:dev");
  r = pass([id(1), id(2)], "idle"); expect(head()).toBe(D2); expect(r.done.find((x: any) => x.id === id(2))).toMatchObject({ ok: true, state: "updated", sha: D2 });
  // an ask queued before the Mac had reported its install type (auth: true, no dev tracking flag) is honoured too
  const E = commit(up, "e"); git(up, "push", "-q", "origin", "HEAD:dev");
  r = pass([id(1), id(2), id(4)], "authonly", { auth: true }); expect(head()).toBe(E); expect(r.done.find((x: any) => x.id === id(4))).toMatchObject({ ok: true, state: "updated", sha: E });
  // asked again with nothing newer: up to date, nothing moves
  r = pass([id(1), id(2), id(3)], "same"); expect(head()).toBe(E); expect(r.done.find((x: any) => x.id === id(3))).toMatchObject({ ok: true, state: "up_to_date" });
  rmSync(d, { recursive: true, force: true });
});

test("Experimental off: the newest commit of the branch the checkout follows (main), never dev; non-fast-forward refused; a failed self-check rolls back", () => {
  const { d, up, mac, H, lc, cfg, A, head } = setup("devoff");
  const M = commit(up, "m"); git(up, "push", "-q", "origin", "HEAD:main", "HEAD:dev"); const N = commit(up, "n"); git(up, "push", "-q", "origin", "HEAD:dev"); // main = M, dev = N
  const pass = runnerPass(d, mac, H, lc, cfg, false);
  let r = pass([id(1)], "ask"); expect(head()).toBe(M); expect(head()).not.toBe(N); expect(r.done[0]).toMatchObject({ id: id(1), ok: true, state: "updated", sha: M, ref: "main" });
  // origin/main force-pushed to a rewritten history: refused, nothing moves
  git(up, "checkout", "-q", "-B", "rw", A); const X = commit(up, "rewritten"); git(up, "push", "-q", "-f", "origin", `${X}:refs/heads/main`);
  r = pass([id(1), id(2)], "nonff"); expect(head()).toBe(M); expect(r.done.find((x: any) => x.id === id(2))).toMatchObject({ ok: false, state: "refused" });
  git(up, "push", "-q", "-f", "origin", `${M}:refs/heads/main`); git(up, "checkout", "-q", "-B", "main2", M);
  // the new code fails its self-check (a runner.ts that loads but can't reach the server): rolled back to M, reported with the sha
  writeFileSync(join(up, "f2"), "x\n"); mkdirSync(join(up, "client"), { recursive: true });
  writeFileSync(join(up, "client", "runner.ts"), `if (process.argv.includes("--help")) console.log("usage (bun client/runner.ts)"); else { console.log("can't reach the server"); process.exit(3); }\n`);
  git(up, "add", "-A"); git(up, "commit", "-qm", "broken"); const F = git(up, "rev-parse", "HEAD"); git(up, "push", "-q", "origin", "HEAD:main");
  r = pass([id(1), id(2), id(3)], "broken"); expect(head()).toBe(M); expect(r.done.find((x: any) => x.id === id(3))).toMatchObject({ ok: false, state: "rolled_back", sha: F, approved_by: "app" });
  rmSync(d, { recursive: true, force: true });
});

test("upgrade from the approval flow: a 'trust' ask and the saved standing approval are dropped, an ask still waiting for its code installs the newest commit, an older Settings page's update_trust just answers it's gone", () => {
  const { d, up, mac, H, lc, cfg, A, head } = setup("migrate");
  const B = commit(up, "b"); git(up, "push", "-q", "origin", "HEAD:main"); const C = commit(up, "c"); git(up, "push", "-q", "origin", "HEAD:main");
  const kb = join(H, ".kitebook"); mkdirSync(join(kb, "update-approvals"), { recursive: true });
  writeFileSync(join(kb, "update-approvals", id(9) + ".json"), "{}"); writeFileSync(join(kb, "update-trust-imac.json"), JSON.stringify({ token: "x.y", by: "password" }));
  writeFileSync(join(kb, "update-asks-imac.json"), JSON.stringify([
    { kind: "dev", id: id(9), by: "hark", at: new Date(Date.now() - 7200_000).toISOString(), expires: Date.now() - 3600_000, sha: B, from: A, ref: "main", code: "BCDFGH", why: "waiting for your approval on your Mac: run kitebook confirm BCDFGH" },
    { kind: "trust", id: id(8), by: "you, in Settings", at: new Date().toISOString(), expires: Date.now() + 3600_000, code: "KLMNPQ", why: "waits for you" }]));
  const r = runnerPass(d, mac, H, lc, cfg, false)([id(9)], "migrate", { cmds: [{ id: "cmd_trust_on01", do: "update_trust", on: true }] });
  expect(head()).toBe(C); // the newest, not the B it once proposed
  expect(r.done.find((x: any) => x.id === id(9))).toMatchObject({ ok: true, state: "updated", sha: C, approved_by: "app" });
  expect(r.done.find((x: any) => x.id === "cmd_trust_on01")).toMatchObject({ ok: true }); expect(r.done.find((x: any) => x.id === "cmd_trust_on01").msg).toMatch(/is gone/);
  expect(r.pending ?? []).toEqual([]); expect(r.trust).toBeNull(); expect(r.nogate).toBe(true);
  expect(existsSync(join(kb, "update-trust-imac.json"))).toBe(false); expect(existsSync(join(kb, "update-approvals"))).toBe(false);
  rmSync(T, { recursive: true, force: true });
});
