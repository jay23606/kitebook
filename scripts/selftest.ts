// The runner, end to end, on whatever OS runs this (CI: ubuntu, macos and windows; smoke.sh stays Linux-only). No bash, no curl, no jq:
//   bun scripts/selftest.ts            (needs npm install; builds the kitebook bundle the first time)
// It starts the real server (scripts/serve.ts: workerd, data in a temp folder), makes a workspace with an assistant and a runner
// (client/admin.ts), runs the runner against a throwaway git repo with a fake coding agent (a bun one-liner, so no agent CLI is needed),
// sends it a task like an assistant would, and checks the task succeeded on its own branch with the agent's file and the verify step.
// Also: `kitebook`'s service status answers with this OS's service manager, and the runner's own platform choices are printed.
import "../client/brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import * as PL from "../client/platform.ts";

const root = join(dirname(import.meta.path), ".."), T = mkdtempSync(join(tmpdir(), "kitebook-selftest-")), port = String(17000 + Math.floor(Math.random() * 20000));
const url = `http://127.0.0.1:${port}`, admin = "selftest-admin-" + crypto.randomUUID().slice(0, 8), bun = process.execPath;
process.env.NO_PROXY = process.env.no_proxy = "localhost,127.0.0.1"; // a proxy in the environment must never see the local server
const env = { ...process.env } as Record<string, string>;
let failed = 0; const procs: any[] = [];
const ok = (c: boolean, what: string, extra = "") => { console.log(`${c ? "PASS" : "FAIL"} ${what}${!c && extra ? `\n  ${extra}` : ""}`); if (!c) failed++; return c; };
const stopAll = () => { for (const p of procs) { try { if (PL.plat() === "win32") PL.killTreeWin(p.pid); else p.kill(); } catch {} } };
const fatal = (m: string) => { console.log(`FAIL ${m}`); for (const f of ["server.log", "runner.log"]) if (existsSync(join(T, f))) console.log(`---- ${f}\n${readFileSync(join(T, f), "utf8").slice(-4000)}`); stopAll(); process.exit(1); };
const run = (argv: string[], o: any = {}) => { const p = Bun.spawnSync(argv, { cwd: root, env: { ...env, ...(o.env ?? {}) }, stdout: "pipe", stderr: "pipe", windowsHide: true } as any);
  return { code: p.exitCode, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() }; };
const call = async (tok: string, op: string, args: any = {}) => { const r = await fetch(`${url}/v1/${op}`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify({ space: "main", ...args }) });
  const txt = await r.text(); let j: any; try { j = JSON.parse(txt); } catch { throw new Error(`${op}: HTTP ${r.status} ${txt.slice(0, 200)}`); } if (!j.ok) throw new Error(`${op}: ${j.error}`); return j.result; };
console.log(`kitebook selftest on ${PL.osName()} (${process.platform}-${process.arch}), bun ${Bun.version}, temp ${T}`);
console.log(`platform: PATH separator "${PL.pathSep()}", dialog ${PL.dialogKind() ?? "none (review page)"}, secrets ${PL.secretStore()}, logs ${PL.logDir()}, kitebook command in ${PL.binDir()}`);

// 1. the server, as the installers run it (no cf dev)
const sv = join(root, ".dev.vars"), hadVars = existsSync(sv); if (!hadVars) writeFileSync(sv, `ADMIN_TOKEN=${admin}\n`, { mode: 0o600 });
const ADM = readFileSync(sv, "utf8").match(/^ADMIN_TOKEN=(.*)$/m)![1].trim();
const slog = require("fs").openSync(join(T, "server.log"), "a");
procs.push(Bun.spawn([bun, join(root, "scripts", "serve.ts")], { cwd: root, env: { ...env, PORT: port, KITEBOOK_DATA: join(T, "data") }, stdout: slog, stderr: slog, windowsHide: true } as any));
let up = false; for (let i = 0; i < 240 && !up; i++) { try { up = (await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch {} if (!up) await Bun.sleep(1000); }
ok(up, `server (scripts/serve.ts, workerd) answers on ${url}/health`) || fatal("server did not start");

// 2. a workspace, an assistant and this machine as a runner
const A = { KITEBOOK_URL: url, KITEBOOK_ADMIN_TOKEN: ADM }, adm = (...a: string[]) => run([bun, join(root, "client", "admin.ts"), ...a], { env: A });
for (let i = 0; i < 30 && adm("list").code; i++) await Bun.sleep(1000); // a just-started server can refuse the first admin calls
adm("space", "main"); const hark = adm("peer", "hark", "assistant").out.split("\n").pop()!, box = adm("peer", "box", "runner").out.split("\n").pop()!;
adm("grant", "hark", "main", "read,write,dispatch", "**"); adm("grant", "box", "main", "read,write,dispatch", "tasks/**", "shared/**", "repos/**");
ok(!!hark && !!box && hark !== box, "admin.ts: workspace, an assistant token and a runner token", JSON.stringify([hark, box, adm("list")])) || fatal("admin setup");

// 3. a throwaway project and the runner with a fake agent (approve=auto: test only, never on a real machine)
const proj = join(T, "proj"), g = (...a: string[]) => run(["git", "-C", proj, "-c", "user.name=t", "-c", "user.email=t@t", ...a]);
run(["git", "init", "-q", "-b", "main", proj]); writeFileSync(join(proj, "README.md"), "selftest\n"); g("add", "-A"); g("commit", "-qm", "init");
const verify = `node -e "process.exit(require('fs').existsSync('selftest.txt') ? 0 : 1)"`;
const agent = [bun, "-e", "require('fs').writeFileSync('selftest.txt', 'made by the fake agent on ' + process.platform + '\\n'); console.log('did it')"];
const cfg = { url, token: box, space: "main", approve: "auto", access: "full", defaultAgent: "fake", agents: { fake: agent }, roots: [],
  projects: { demo: { path: proj, agent: "fake", verify: [verify] } } }; // a task's verify must be one the project allows
const cfgPath = join(T, "runner.json"); writeFileSync(cfgPath, JSON.stringify(cfg, null, 1), { mode: 0o600 });
const H = { HOME: T, USERPROFILE: T, KITEBOOK_TEST: "1", KITEBOOK_SVC_DIR: join(T, "svc") }, rlog = require("fs").openSync(join(T, "runner.log"), "a");
procs.push(Bun.spawn([bun, join(root, "client", "runner.ts"), cfgPath], { cwd: root, env: { ...env, ...H }, stdout: rlog, stderr: rlog, windowsHide: true } as any));

// 4. an assistant sends a task; the runner runs it in a worktree on its own branch
let online = false, last = ""; for (let i = 0; i < 60 && !online; i++) { try { const d = await call(hark, "describe"); last = JSON.stringify(d.runners ?? d).slice(0, 400); online = (d.runners ?? []).some((r: any) => r.name === "box"); } catch (e: any) { last = e.message; } if (!online) await Bun.sleep(1000); }
ok(online, "runner connected and advertised itself (describe lists it)", last) || fatal("runner never came online");
const t = await call(hark, "task_create", { target: "box", title: "selftest", instructions: "Create selftest.txt", project: "demo", verify });
let st: any = null; for (let i = 0; i < 120; i++) { st = await call(hark, "task_get", { id: t.id }); if (["succeeded", "failed", "rejected", "cancelled"].includes(st.state)) break; await Bun.sleep(1000); }
ok(st?.state === "succeeded", `task ${t.id} succeeded`, JSON.stringify({ state: st?.state, note: st?.note, summary: st?.result?.summary }).slice(0, 600));
const br = `kitebook/${t.id}`, file = run(["git", "-C", proj, "show", `${br}:selftest.txt`]);
ok(file.code === 0 && file.out.startsWith("made by the fake agent"), `the agent's file is committed on ${br}`, file.err);
ok(run(["git", "-C", proj, "rev-parse", "--abbrev-ref", "HEAD"]).out === "main" && !existsSync(join(proj, "selftest.txt")), "the project's own checkout is untouched (the task ran in a worktree)");
const vl = await call(hark, "read", { path: `tasks/${t.id}/verify.log` }).then((r: any) => String(r.content ?? ""), (e: any) => `unreadable: ${e.message}`);
ok(/^exit 0$/m.test(vl), "the task's verify command ran through this OS's shell and passed (verify.log: exit 0)", vl.slice(0, 400));

// 5. the service manager the `kitebook` command would use here
const s = run([bun, join(root, "client", "runner.ts"), "service", cfgPath, "status"], { env: H });
let sj: any = null; try { sj = JSON.parse(s.out); } catch {}
ok(s.code === 0 && !!sj?.runner, `kitebook service status answers (${PL.plat() === "darwin" ? "launchd" : PL.plat() === "win32" ? "Kitebook's supervisor" : "systemd --user or Kitebook's supervisor"})`, s.out + s.err);

stopAll(); if (!hadVars) try { require("fs").unlinkSync(sv); } catch {}
console.log(failed ? `SELFTEST FAILED (${failed})` : "SELFTEST PASSED"); process.exit(failed ? 1 : 0);
