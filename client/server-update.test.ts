// U1 (owner, 2026-10-23 04:06): an update on a workerd host (scripts/serve.sh) must bring the SERVER folder to the new commit too, and only
// say updated once the server serves it (client/host-upgrade.ts workerdHost / syncPlan / serverSync; /health?build=1). A fake launchctl
// (runner.json "launchctl") and a tiny HTTP stand-in for the server: no real launchd, workerd or npm here.
import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, chmodSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const T = mkdtempSync(join(tmpdir(), "kitebook-srvupd-"));
afterAll(() => rmSync(T, { recursive: true, force: true }));
const git = (d: string, ...a: string[]) => { const p = Bun.spawnSync(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { stdout: "pipe", stderr: "pipe" }); if (p.exitCode) throw new Error(`git ${a.join(" ")}: ${p.stderr}`); return p.stdout.toString().trim(); };
const D = JSON.stringify(import.meta.dir);
const plist = (dir: string, port: number, serve = true) => `<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>dev.kitebook.server</string>
  <key>WorkingDirectory</key><string>${dir}</string><key>ProgramArguments</key><array><string>/bin/bash</string><string>${serve ? `${dir}/scripts/serve.sh` : "node_modules/.bin/cf"}</string>${serve ? "" : "<string>dev</string>"}</array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/usr/bin:/bin</string><key>PORT</key><string>${port}</string></dict></dict></plist>`;

// a checkout (src with two commits), a server folder holding the FIRST commit's code, a plist on serve.sh, a fake launchctl, a fake server
function setup(name: string) {
  const d = join(T, name), src = join(d, "src"), srv = join(d, "srv"), H = join(d, "home"), lc = join(d, "launchctl");
  mkdirSync(join(src, "src"), { recursive: true }); mkdirSync(join(H, "Library", "LaunchAgents"), { recursive: true }); mkdirSync(srv, { recursive: true });
  git(src, "init", "-q"); writeFileSync(join(src, "src", "index.ts"), "v1\n"); writeFileSync(join(src, "package-lock.json"), "{}\n"); git(src, "add", "-A"); git(src, "commit", "-qm", "a");
  const A = git(src, "rev-parse", "HEAD");
  Bun.spawnSync(["bash", "-c", `git -C ${src} archive HEAD | tar -xf - -C ${srv}`]); mkdirSync(join(srv, "node_modules")); writeFileSync(join(srv, ".dev.vars"), "ADMIN_TOKEN=keep\n"); writeFileSync(join(srv, "runner.json"), "{\"keep\":1}\n");
  mkdirSync(join(srv, ".cloudflare/output/v0/workers/default/bundle"), { recursive: true }); writeFileSync(join(srv, ".cloudflare/output/v0/workers/default/bundle/index.js"), `// built ${A}\n`);
  writeFileSync(join(src, "src", "index.ts"), "v2\n"); git(src, "commit", "-qam", "b"); const B = git(src, "rev-parse", "HEAD");
  writeFileSync(lc, `#!/bin/sh\necho "$@" >> ${d}/kicks\nexit 0\n`); chmodSync(lc, 0o755);
  return { d, src, srv, H, lc, A, B };
}
// a stand-in server on a free port whose /health?build=1 names the commit baked into srv's bundle ("// built <sha>"), re-read on every hit
function fakeServer(srv: string, o: { ignoreBundle?: string } = {}) {
  return Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(req) { const u = new URL(req.url); if (u.pathname !== "/health") return new Response("no", { status: 404 });
    let c: string | null = null; try { c = readFileSync(join(srv, ".cloudflare/output/v0/workers/default/bundle/index.js"), "utf8").match(/built ([0-9a-f]{40})/)?.[1] ?? null; } catch {}
    if (o.ignoreBundle) c = null; // a server that never says the new commit (the restart didn't load the new code)
    return Response.json(u.searchParams.has("build") ? { ok: true, commit: c } : { ok: true }); } });
}
function child(H: string, code: string, env: Record<string, string> = {}) {
  const p = Bun.spawnSync([process.execPath, "-e", code], { env: { ...process.env, HOME: H, KITEBOOK_TASK_ID: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", KITEBOOK_SYNC_HEALTH_SEC: "5", ...env }, stdout: "pipe", stderr: "pipe", timeout: 60_000 });
  const l = p.stdout.toString().split("\n").reverse().find(x => x.startsWith("RESULT ")); if (!l) throw new Error(p.stdout.toString() + p.stderr.toString()); return JSON.parse(l.slice(7));
}
const BUILD = (srv: string) => `printf '// built %s\\n' "$KITEBOOK_BUILD_COMMIT" > ${srv}/.cloudflare/output/v0/workers/default/bundle/index.js.tmp; mkdir -p ${srv}/.cloudflare/output/v0/workers/default/bundle; mv ${srv}/.cloudflare/output/v0/workers/default/bundle/index.js.tmp ${srv}/.cloudflare/output/v0/workers/default/bundle/index.js 2>/dev/null || { mkdir -p ${srv}/.cloudflare/output/v0/workers/default/bundle; printf '// built %s\\n' "$KITEBOOK_BUILD_COMMIT" > ${srv}/.cloudflare/output/v0/workers/default/bundle/index.js; }`;

test("workerd host detected (serve.sh plist) -> copy + build + restart planned; the old cf dev host and a current server are left to their paths", () => {
  const { d, src, srv, H, lc, A, B } = setup("plan"); const cfg = join(d, "runner.json");
  writeFileSync(cfg, JSON.stringify({ launchctl: lc, source: src }));
  writeFileSync(join(H, "Library/LaunchAgents/dev.kitebook.server.plist"), plist(srv, 7999));
  const r = child(H, `const HU = await import(${D} + "/host-upgrade.ts"), cfg = JSON.parse(require("fs").readFileSync(${JSON.stringify(cfg)}, "utf8"));
    const h = HU.workerdHost(cfg, ${JSON.stringify(cfg)}), old = HU.oldHost(cfg, ${JSON.stringify(cfg)});
    console.log("RESULT " + JSON.stringify({ h, old, stale: HU.syncPlan(h, ${JSON.stringify(src)}, ${JSON.stringify(B)}, ${JSON.stringify(A)}), unnamed: HU.syncPlan(h, ${JSON.stringify(src)}, ${JSON.stringify(B)}, null),
      current: HU.syncPlan(h, ${JSON.stringify(src)}, ${JSON.stringify(B)}, ${JSON.stringify(B)}), inPlace: HU.syncPlan({ ...h, dir: ${JSON.stringify(src)} }, ${JSON.stringify(src)}, ${JSON.stringify(B)}, ${JSON.stringify(A)}) }));`);
  expect(r.h).toMatchObject({ dir: srv, port: 7999, label: "dev.kitebook.server" }); expect(r.old).toBeNull();
  expect(r.stale).toMatchObject({ action: "sync", copy: true, npm: false }); expect(r.stale.why).toContain(A.slice(0, 7));
  expect(r.unnamed).toMatchObject({ action: "sync", copy: true }); expect(r.unnamed.why).toMatch(/doesn't say/);
  expect(r.current.action).toBe("none"); expect(r.inPlace).toMatchObject({ action: "none", copy: false }); // in place (get.sh): the update's own restart + health check, as before
  // the cf dev host (no serve.sh): not a workerd host; the old upgrade path (upgrade-mac-host.sh) stays in charge, unchanged
  writeFileSync(join(H, "Library/LaunchAgents/dev.kitebook.server.plist"), plist(srv, 7999, false));
  const o = child(H, `const HU = await import(${D} + "/host-upgrade.ts"), cfg = JSON.parse(require("fs").readFileSync(${JSON.stringify(cfg)}, "utf8")); cfg.server = { dir: ${JSON.stringify(srv)} };
    console.log("RESULT " + JSON.stringify({ h: HU.workerdHost(cfg, ${JSON.stringify(cfg)}), old: HU.oldHost(cfg, ${JSON.stringify(cfg)}) }));`);
  expect(o.h).toBeNull(); expect(o.old).toMatchObject({ dir: srv });
});

test("post-update on a stale workerd server: copies the code (keeps .dev.vars, runner.json), builds with the commit, restarts it, waits until /health?build=1 names HEAD", async () => {
  const { d, src, srv, H, lc, A, B } = setup("ok"), fs = fakeServer(srv), cfg = join(d, "runner.json");
  try {
    writeFileSync(cfg, JSON.stringify({ launchctl: lc, source: src })); writeFileSync(join(H, "Library/LaunchAgents/dev.kitebook.server.plist"), plist(srv, fs.port!));
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "host-upgrade.ts"), "post-update", cfg, "--caller-rolls-back", "--from", A], { cwd: src, env: { ...process.env, HOME: H, KITEBOOK_TASK_ID: "", KITEBOOK_SYNC_HEALTH_SEC: "5", KITEBOOK_SYNC_BUILD: BUILD(srv) }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(), err = await new Response(p.stderr).text(); await p.exited; let j: any; try { j = JSON.parse(out.trim().split("\n").pop()!); } catch { throw new Error(out + err); }
    if (j.post_update !== "server updated") throw new Error(JSON.stringify(j) + "\n" + readFileSync(join(H, ".kitebook/server-sync.out"), "utf8"));
    expect(j).toMatchObject({ post_update: "server updated", server_handled: true, runner_restarts: false, server_sha: B });
    expect(readFileSync(join(srv, "src/index.ts"), "utf8")).toBe("v2\n"); expect(readFileSync(join(srv, ".dev.vars"), "utf8")).toBe("ADMIN_TOKEN=keep\n"); expect(readFileSync(join(srv, "runner.json"), "utf8")).toContain("keep");
    expect(readFileSync(join(srv, ".kitebook-commit"), "utf8").trim()).toBe(B); expect(readFileSync(join(d, "kicks"), "utf8")).toMatch(/kickstart -k gui\/\d+\/dev\.kitebook\.server/);
    expect(existsSync(join(srv, ".cloudflare/output.prev"))).toBe(false); // no backup left behind
    expect(JSON.parse(readFileSync(join(H, ".kitebook/server-sync.json"), "utf8"))).toMatchObject({ head: B, from: A, state: "done" });
    expect(readFileSync(join(H, "Library/Logs/kitebook-upgrade.log"), "utf8")).toContain(`done: the server runs ${B.slice(0, 7)}`);
    expect(git(src, "rev-parse", "HEAD")).toBe(B);
  } finally { fs.stop(true); }
});

test("sha mismatch after the restart -> the previous bundle and sources go back, restarted; server_update_failed with the log; an older caller's checkout is put back too", async () => {
  const { d, src, srv, H, lc, A, B } = setup("rollback"), fs = fakeServer(srv, { ignoreBundle: "never" }), cfg = join(d, "runner.json");
  try {
    writeFileSync(cfg, JSON.stringify({ launchctl: lc, source: src })); writeFileSync(join(H, "Library/LaunchAgents/dev.kitebook.server.plist"), plist(srv, fs.port!));
    const bundle = join(srv, ".cloudflare/output/v0/workers/default/bundle/index.js"), before = readFileSync(bundle, "utf8");
    // an older gitUpdate (no --caller-rolls-back): the checkout came from A by a fast-forward (ORIG_HEAD)
    git(src, "reset", "-q", "--hard", A); git(src, "merge", "--ff-only", "-q", B);
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "host-upgrade.ts"), "post-update", cfg, "--in-runner"], { cwd: src, env: { ...process.env, HOME: H, KITEBOOK_TASK_ID: "", NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost", KITEBOOK_SYNC_HEALTH_SEC: "3", KITEBOOK_SYNC_BUILD: BUILD(srv) }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text(); expect(await p.exited).toBe(1); const j = JSON.parse(out.trim().split("\n").pop()!);
    expect(j).toMatchObject({ post_update: "server_update_failed", server_handled: true, runner_restarts: false, log: "~/Library/Logs/kitebook-upgrade.log" });
    expect(j.error).toMatch(/not .*on 127\.0\.0\.1/); expect(j.error).toMatch(/previous server back/); expect(j.error).toContain(`checkout went back to ${A.slice(0, 7)}`);
    expect(readFileSync(bundle, "utf8")).toBe(before); expect(readFileSync(join(srv, "src/index.ts"), "utf8")).toBe("v1\n"); // the previous code, as it ran
    expect(readFileSync(join(d, "kicks"), "utf8").trim().split("\n").length).toBe(2); // the new code's restart, then the rollback's
    expect(git(src, "rev-parse", "HEAD")).toBe(A);
    expect(JSON.parse(readFileSync(join(H, ".kitebook/server-sync.json"), "utf8"))).toMatchObject({ head: B, state: "failed" });
    expect(readFileSync(join(H, "Library/Logs/kitebook-upgrade.log"), "utf8")).toMatch(/FAILED: .*putting the previous server back/);
    const h = JSON.parse(readFileSync(join(H, ".kitebook/updates.json"), "utf8")); expect(h.pop()).toMatchObject({ result: "rolled back", to: B.slice(0, 7) });
  } finally { fs.stop(true); }
});

test("cf dev path unchanged: no serve.sh plist -> post-update says nothing about a workerd server (no copy, no restart)", () => {
  const { d, src, srv, H, lc } = setup("cfdev"), cfg = join(d, "runner.json");
  writeFileSync(cfg, JSON.stringify({ launchctl: lc, source: src })); // no server job at all
  const p = Bun.spawnSync([process.execPath, join(import.meta.dir, "host-upgrade.ts"), "post-update", cfg], { cwd: src, env: { ...process.env, HOME: H, KITEBOOK_TASK_ID: "" }, stdout: "pipe", stderr: "pipe" });
  expect(JSON.parse(p.stdout.toString().trim().split("\n").pop()!)).toMatchObject({ post_update: "nothing to do", server_handled: false });
  expect(existsSync(join(d, "kicks"))).toBe(false); expect(readFileSync(join(srv, "src/index.ts"), "utf8")).toBe("v1\n");
  // a task can't run it
  const t = Bun.spawnSync([process.execPath, join(import.meta.dir, "host-upgrade.ts"), "post-update", cfg], { cwd: src, env: { ...process.env, HOME: H, KITEBOOK_TASK_ID: "t_1" }, stdout: "pipe", stderr: "pipe" });
  expect(t.exitCode).toBe(1); expect(t.stdout.toString()).toContain("refused");
});
