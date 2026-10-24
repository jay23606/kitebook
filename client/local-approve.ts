// Approve at the computer, without the phone: `bun runner.ts approve [runner.json]` lists what waits for you and answers it.
// Every ask the runner puts to its owner (run or push; not the deploy/spend/send gate, which stays on the phone or dialog) is also
// written to ~/.kitebook/asks/<runner>.<task>.json (0600: title, sender, project, why, the short approval code). The CLI writes
// <runner>.<task>.answer with the code it was shown and KEEPS THE FILE OPEN until the runner answers; the runner takes it only if the code
// is the one it is asking with now (a stale answer for a changed task is void) and the process the OS says holds that file open (/proc on
// Linux, lsof on macOS; never a pid the file claims) is not one of the runner's own descendants and runs in a terminal (a controlling tty:
// agents the runner starts have none). So an agent can't approve another task by writing the file, by naming someone else's pid, or from
// a pipe. Same-user limits still apply (an agent that detaches from the runner's tree AND allocates itself a pty gets past it), like the
// guard's shims: a tripwire, logged in the audit log, not a sandbox. The macOS dialog and the phone stay the stronger ways.
// Windows has no /proc and no lsof (and a file held open can't be deleted there), so the CLI proves itself another way: it listens on a
// loopback port while it waits and names that port in the file; the runner asks the OS who owns the listening socket (netstat -ano, the
// same table Get-NetTCPConnection reads), and walks parents in the CIM process table (creation times checked, so a reused pid doesn't
// count as a parent). "A terminal" there means the process descends from your desktop (explorer.exe or Windows Terminal): a Scheduled
// Task's or service's children don't. Same tripwire limits: an agent that gets Explorer to start a program for it gets past that check.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync, chmodSync, openSync, writeSync, closeSync, readlinkSync, realpathSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const askDir = () => join(homedir(), ".kitebook", "asks");
const isWin = () => process.platform === "win32";
// How a CLI proves which process it is: "file" (the runner asks who holds the file open: /proc, lsof) or "port" (who listens on the port
// the file names: Windows). KITEBOOK_LOCAL_PROOF=port (tests, with KITEBOOK_TEST) runs the Windows way here, with /proc/net/tcp.
export const proofWay = (): "file" | "port" => isWin() || (process.env.KITEBOOK_TEST && process.env.KITEBOOK_LOCAL_PROOF === "port") ? "port" : "file";
const out = (argv: string[]) => { try { return new TextDecoder().decode(Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore", windowsHide: true } as any).stdout); } catch { return ""; } };

// ---- Windows: the process table (one CIM snapshot per check) and the listening sockets ----
export type WinProc = { ppid: number; created: number; name: string };
// lines "<pid> <ppid> <creation filetime> <name>" (PowerShell below); System Idle / System have no creation time (0)
export function parseWinProcs(text: string): Map<number, WinProc> {
  const m = new Map<number, WinProc>();
  for (const l of text.split(/\r?\n/)) { const x = l.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/); if (x) m.set(Number(x[1]), { ppid: Number(x[2]), created: Number(x[3]), name: x[4].trim() }); }
  return m;
}
export const winProcs = () => parseWinProcs(out(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
  "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }), $_.Name }"]));
// pid's ancestors, nearest first; stops where the parent is gone or was started after its "child" (the pid was reused by a newer process)
export function winChain(t: Map<number, WinProc>, pid: number): number[] {
  const chain: number[] = []; let p = pid;
  for (let i = 0; i < 64; i++) { const me = t.get(p); if (!me || !me.ppid || me.ppid === p) break; const par = t.get(me.ppid);
    if (!par || (par.created && me.created && par.created > me.created)) break; chain.push(me.ppid); p = me.ppid; }
  return chain;
}
const DESKTOP = /^(explorer|windowsterminal)\.exe$/i;
// the desktop process this one was started from (its "terminal"), or null: a Scheduled Task's, a service's or a detached child's chain has none
export const winDesktop = (t: Map<number, WinProc>, pid: number): string | null => { for (const a of winChain(t, pid)) { const n = t.get(a)?.name ?? ""; if (DESKTOP.test(n)) return n; } return null; };
// `netstat -ano -p TCP`: the pid listening on 127.0.0.1:<port>. A listening row's foreign address is 0.0.0.0:0, so the state word (which
// Windows translates) isn't needed.
export function parseNetstat(text: string, port: number): number[] {
  const pids = new Set<number>();
  for (const l of text.split(/\r?\n/)) { const c = l.trim().split(/\s+/); if (c.length < 4 || !/^TCP$/i.test(c[0])) continue;
    if (c[1] === `127.0.0.1:${port}` && c[2] === "0.0.0.0:0") { const pid = Number(c[c.length - 1]); if (Number.isInteger(pid) && pid > 0) pids.add(pid); } }
  return [...pids];
}
// who listens on 127.0.0.1:<port>, as the OS reports it: netstat on Windows, /proc/net/tcp + /proc/<pid>/fd on Linux, lsof on macOS
export function listeners(port: number): number[] {
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return [];
  if (isWin()) return parseNetstat(out(["netstat", "-ano", "-p", "TCP"]), port);
  if (existsSync("/proc/net/tcp")) { const hex = `0100007F:${port.toString(16).toUpperCase().padStart(4, "0")}`, inodes = new Set<string>();
    try { for (const l of readFileSync("/proc/net/tcp", "utf8").split("\n").slice(1)) { const c = l.trim().split(/\s+/); if (c[1] === hex && c[3] === "0A") inodes.add(`socket:[${c[9]}]`); } } catch {}
    const res: number[] = []; if (!inodes.size) return res;
    for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue; let fds: string[]; try { fds = readdirSync(`/proc/${d}/fd`); } catch { continue; }
      for (const f of fds) { try { if (inodes.has(readlinkSync(`/proc/${d}/fd/${f}`))) { res.push(Number(d)); break; } } catch {} } }
    return res; }
  return out(["lsof", "-t", `-iTCP@127.0.0.1:${port}`, "-sTCP:LISTEN"]).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

const ppid = (pid: number): number | null => { try { const r = Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)]); const n = parseInt(new TextDecoder().decode(r.stdout).trim(), 10); return Number.isFinite(n) ? n : null; } catch { return null; } };
// true when pid is alive and none of its ancestors is `root` (the runner)
export function outsideOf(pid: number, root = process.pid, t?: Map<number, WinProc>): boolean {
  if (isWin()) { const tab = t ?? winProcs(); return tab.has(pid) && pid !== root && !winChain(tab, pid).includes(root); }
  let p: number | null = pid; for (let i = 0; i < 64 && p && p > 1; i++) { if (p === root) return false; p = ppid(p); }
  return ppid(pid) !== null;
}
// The processes holding `file` open right now, as the OS reports them (not what anyone wrote): /proc/<pid>/fd on Linux, lsof elsewhere.
export function holders(file: string): number[] {
  if (existsSync("/proc/self/fd")) { let real = file; try { real = realpathSync(file); } catch {} const out: number[] = [];
    for (const d of readdirSync("/proc")) { if (!/^\d+$/.test(d)) continue; let fds: string[]; try { fds = readdirSync(`/proc/${d}/fd`); } catch { continue; }
      for (const f of fds) { try { if (readlinkSync(`/proc/${d}/fd/${f}`) === real) { out.push(Number(d)); break; } } catch {} } }
    return out; }
  try { const r = Bun.spawnSync(["lsof", "-t", "--", file]); return new TextDecoder().decode(r.stdout).split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger); } catch { return []; }
}
export const ttyOf = (pid: number, t?: Map<number, WinProc>): string | null => { if (isWin()) return winDesktop(t ?? winProcs(), pid);
  try { const tt = new TextDecoder().decode(Bun.spawnSync(["ps", "-o", "tty=", "-p", String(pid)]).stdout).trim(); return tt && !/^\?+$/.test(tt) ? tt : null; } catch { return null; } };
// null = the answer really comes from a terminal outside this runner's tree; else why not. claim: what the file says ({pid, port});
// tty: also require a controlling terminal (on Windows: started from your desktop).
export function checkAnswerer(file: string, claim: { pid?: unknown; port?: unknown } | null | undefined, tty: boolean): string | null {
  const port = proofWay() === "port", hs = (port ? listeners(Number(claim?.port)) : holders(file)).filter(p => p !== process.pid), claimed = claim?.pid;
  if (!hs.length) return port ? "refused: no process is waiting on the port the answer names (kitebook approve listens there until the runner answers; a file written by anything else doesn't count)"
    : "refused: no process holds the answer open (kitebook approve keeps it open until the runner answers; a file written by anything else doesn't count)";
  if (!Number.isInteger(claimed) || !hs.includes(claimed as number)) return "refused: the answer names a process that isn't the one that wrote it";
  const t = isWin() ? winProcs() : undefined; // one snapshot for both checks
  if (hs.some(p => !outsideOf(p, process.pid, t))) return "refused: it came from a process this runner started";
  if (tty && hs.some(p => !ttyOf(p, t))) return isWin() ? "refused: answer from your own terminal (kitebook approve in PowerShell or Windows Terminal); a process not started from your desktop can't approve"
    : "refused: answer from your own terminal (kitebook approve in Terminal); a process without a terminal can't approve";
  return null;
}
// keep a request/answer file open while waiting, so the runner can ask the OS who wrote it
// (the "file" way); the "port" way (Windows) writes it, closes it, and listens on a loopback port named in it instead
const holdWrite = (f: string, body: Record<string, unknown>) => { rmSync(f, { force: true });
  if (proofWay() === "port") { const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open(s) { s.end(); }, data() {} } });
    writeFileSync(f, JSON.stringify({ ...body, port: srv.port }), { mode: 0o600 }); return () => { try { srv.stop(true); } catch {} }; }
  const fd = openSync(f, "w", 0o600); writeSync(fd, JSON.stringify(body)); return () => { try { closeSync(fd); } catch {} }; };
export type LocalAsk = { task: string; short: string; nonce: string; exp: number; text: string; view: any };
// Runner side: publish the ask, wait for a matching answer. Resolves only with an answer; on abort it cleans up and never resolves.
export function localWay(name: string, a: LocalAsk, s: AbortSignal, log: (...x: any[]) => void, audit: (e: any) => void): Promise<{ yes: boolean; nonce: string; presence?: string }> {
  const d = askDir(), base = join(d, `${name}.${a.task}`);
  try { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); rmSync(base + ".answer", { force: true });
    writeFileSync(base + ".json", JSON.stringify({ runner: name, task: a.task, code: a.short, gate: a.view?.gate ?? "run", title: a.view?.title ?? null, from: a.view?.asked_by ?? a.view?.from ?? null,
      project: a.view?.project ?? null, why: a.view?.why ?? null, login: !!a.view?.login, app: a.view?.app ?? null, name: a.view?.name ?? null, expires: new Date(a.exp).toISOString(), text: String(a.text).slice(0, 4000) }, null, 1), { mode: 0o600 }); } catch (e: any) { log("local approval file:", e.message); }
  const done = (r: { ok: boolean; why: string }) => { try { writeFileSync(base + ".result", JSON.stringify(r), { mode: 0o600 }); } catch {} };
  return new Promise(res => {
    const stop = () => { clearInterval(iv); rmSync(base + ".json", { force: true }); rmSync(base + ".answer", { force: true }); };
    const iv = setInterval(() => {
      if (s.aborted) return stop();
      let ans: any; try { ans = JSON.parse(readFileSync(base + ".answer", "utf8")); } catch { return; }
      const bad = ans?.code === a.short ? checkAnswerer(base + ".answer", ans, !(process.env.KITEBOOK_TEST && process.env.KITEBOOK_TEST_NO_TTY)) : null; // who holds it: asked before the file goes
      rmSync(base + ".answer", { force: true });
      if (ans?.code !== a.short) { done({ ok: false, why: `code ${ans?.code} isn't the current one (${a.short}): the task changed or was asked again; list again` }); return; }
      if (bad) { log("ignored a local approval for", a.task, "-", bad); audit({ type: "local_approval_refused", task: a.task, pid: ans.pid ?? null, why: bad.slice(9, 80) }); done({ ok: false, why: bad }); return; }
      audit({ type: "local_approval", task: a.task, code: a.short, yes: !!ans.yes, pid: ans.pid }); done({ ok: true, why: ans.yes ? "approved" : "rejected" });
      stop(); res({ yes: !!ans.yes, nonce: a.nonce, ...(typeof ans.presence === "string" && ans.presence.length < 2000 ? { presence: ans.presence } : {}) }); // the CLI's presence assertion (connection approvals), checked by the server
    }, 500);
    s.addEventListener("abort", stop);
  });
}
// what `kitebook approve <code> yes|no` prints once the runner took the answer (newuser #19: it printed "cr_feaaefbd…: approved")
export function answerWords(x: any, yes: boolean): string {
  const login = x.gate === "connect" && (x.login || /wants to sign in/.test(String(x.title ?? ""))), app = String(x.app ?? x.from ?? "").trim();
  if (login) return yes ? `Signed in: ${app || "that browser"}. It stays signed in for 30 days.` : `Sign-in refused${app ? ` for ${app}` : ""}. That browser is not signed in.`;
  if (x.gate === "connect") return yes ? `Connected: ${x.name || app || "the app"}${x.name && app && x.name !== app ? ` (${app})` : ""}. It finishes connecting on its own.` : `Not connected: ${app || x.name || "the app"} gets nothing.`;
  const what = `${x.title ?? x.task}${x.project ? ` (${x.project})` : ""}`;
  if (x.gate === "push") return yes ? `Push approved: ${what}.` : `Push refused: ${what}. Nothing was pushed.`;
  return yes ? `Approved: ${what}. It starts now on ${x.runner ?? "this Mac"}.` : `Rejected: ${what}. It won't run.`;
}
// CLI: approve [runner.json] (list; with a terminal, asks y/n/skip for each) | approve [runner.json] <task|code> yes|no
export async function approveCli(argv: string[]): Promise<number> {
  const rest = [...argv]; if (rest[0] && (rest[0].endsWith(".json") || existsSync(rest[0]))) rest.shift(); // the config path (optional; asks are per machine)
  const d = askDir(), list = (existsSync(d) ? readdirSync(d) : []).filter(f => f.endsWith(".json")).map(f => { try { return JSON.parse(readFileSync(join(d, f), "utf8")); } catch { return null; } })
    .filter((x: any) => x && Date.parse(x.expires) > Date.now());
  const answer = async (x: any, yes: boolean) => { const base = join(d, `${x.runner}.${x.task}`); rmSync(base + ".result", { force: true });
    // approving a connection widens access: this device's presence key signs exactly this approval (Touch ID / Windows Hello / password)
    let presence: string | null = null; if (yes && x.gate === "connect") { const DV = await import("./device.ts");
      if (DV.loadState(x.runner)?.state === "active") { presence = await DV.assertFor(x.runner, `connect:${x.task}`, `approve code ${x.code}`); if (!presence) { console.error(`${x.task}: not confirmed (no master password or Touch ID / Windows Hello given here); nothing was approved`); return 1; } } }
    const close = holdWrite(base + ".answer", { code: x.code, yes, pid: process.pid, at: new Date().toISOString(), ...(presence ? { presence } : {}) }); // held open: the runner asks the OS who wrote it
    try { for (let i = 0; i < 40; i++) { await Bun.sleep(250); try { const r = JSON.parse(readFileSync(base + ".result", "utf8")); rmSync(base + ".result", { force: true }); console.log(r.ok ? answerWords(x, yes) : `${x.task}: ${r.why}`); return r.ok ? 0 : 1; } catch {} } } finally { close(); }
    rmSync(base + ".answer", { force: true }); console.error(`${x.task}: the runner didn't pick the answer up (is it running?)`); return 1; };
  const [which, word] = rest;
  if (which) { const x = list.find((y: any) => y.task === which || String(y.code).toUpperCase() === which.toUpperCase());
    if (!x && /^[A-Za-z]{4}-[A-Za-z]{4}$/.test(which) && !list.some((y: any) => String(y.code).toUpperCase() === which.toUpperCase())) { // a pairing code (POST /connect)
      const DV = await import("./device.ts"), c = DV.cfgOf(argv); if (c) return await DV.pairApprove(c, which); }
    if (!x) { console.error(`nothing waiting with id or code ${which}${list.length ? `; waiting: ${list.map((y: any) => `${y.task} [${y.code}]`).join(", ")}` : ""}`); return 1; }
    if (word === undefined && process.stdin.isTTY) { process.stdout.write(`${x.gate === "connect" ? x.title : `Approve [${x.code}] ${x.title ?? x.task}`}?\n${x.gate === "connect" ? String(x.text ?? "").split("\n")[1] ?? "" : ""}\nApprove? [y/N] `); // kitebook approve <code>: asks y/N here
      let a = ""; for await (const line of console) { a = line.trim().toLowerCase(); break; } return await answer(x, a === "y" || a === "yes"); }
    if (!/^(yes|y|approve|no|n|reject)$/.test(word ?? "")) { console.error("say yes or no: kitebook approve <code> yes|no"); return 2; }
    return await answer(x, /^(yes|y|approve)$/.test(word)); }
  if (!list.length) { console.log("Nothing waits for your approval."); return 0; }
  // a new app connecting (gate connect): "[BCDF-GHJK] Connect: Pi wants to connect (folder: kb/pi)" plus what it would get
  for (const x of list) console.log(x.gate === "connect" ? `\n[${x.code}] Connect: ${x.title}\n  ${String(x.text ?? "").split("\n")[1] ?? ""}\n  check the code matches the page in your browser · expires ${new Date(x.expires).toLocaleTimeString()}`
    : `\n[${x.code}] ${x.gate === "push" ? "Push" : "Run"}: ${x.title ?? x.task}\n  from ${x.from ?? "?"} · project ${x.project ?? "none"} · runner ${x.runner} · task ${x.task}\n  ${x.why ?? ""}\n  expires ${new Date(x.expires).toLocaleTimeString()}`);
  if (!process.stdin.isTTY) { console.log(`\nAnswer with: kitebook approve <code> yes   (or no)`); return 0; }
  let rc = 0; for (const x of list) { process.stdout.write(`\nApprove [${x.code}] ${x.title ?? x.task}? [y/N/s=skip] `); let a = ""; for await (const line of console) { a = line.trim().toLowerCase(); break; }
    if (a === "s" || a === "skip") continue; rc |= await answer(x, a === "y" || a === "yes"); }
  return rc;
}

// `kitebook open`: open this Kitebook's /start in the browser, already signed in (and remembered for 30 days), no recovery code. The CLI asks
// the running runner through the asks folder (so the same tripwire applies: a process the runner started is refused), the runner gets
// a single-use 5-minute link from the server, and the CLI opens it: `open` on macOS, xdg-open on Linux (when there is a display), else
// it prints the link to paste. --print only prints it.
export async function openCli(argv: string[]): Promise<number> {
  const d = askDir(), to = argv.includes("--settings") ? "settings" : null; mkdirSync(d, { recursive: true, mode: 0o700 }); // kitebook settings = kitebook open --settings
  // the nonce stays here: the runner's device-signed token carries only its hash, and the CLI adds the nonce to the link it opens, so a token
  // read from a log or the runner's files alone signs nobody in (client/device.ts, src/open.ts)
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url"), nh = await (await import("./device.ts")).sha256hex(nonce);
  const base = join(d, `open.${process.pid}`); rmSync(base + ".res", { force: true }); const close = holdWrite(base + ".req", { pid: process.pid, at: Date.now(), to, nh }); // held open (the runner asks the OS who wrote it)
  for (let i = 0; i < 60; i++) { await Bun.sleep(250); let r: any; try { r = JSON.parse(readFileSync(base + ".res", "utf8")); } catch { continue; } close(); rmSync(base + ".res", { force: true });
    if (!r.url) { console.error(`kitebook open: ${r.error}`); return 1; }
    const dev = /\/open#t=/.test(r.url); if (dev) r.url += `&n=${nonce}`;
    // the browser is opened on a one-shot loopback address that redirects to the link (fragment and all), so the token never sits in a
    // process's arguments where another local process could read it; --print prints the link itself
    let target = r.url, srv: any = null, served = () => {}; const hit = new Promise<void>(z => { served = z; });
    if (dev && !argv.includes("--print") && process.env.KITEBOOK_NO_OPEN !== "1") { const path = "/" + Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url"), link = r.url;
      try { srv = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(q) { if (new URL(q.url).pathname !== path) return new Response("not found", { status: 404 }); setTimeout(() => { srv?.stop(true); served(); }, 200); return new Response(null, { status: 302, headers: { location: link, "cache-control": "no-store", "referrer-policy": "no-referrer" } }); } });
        target = `http://127.0.0.1:${srv.port}${path}`; setTimeout(() => srv?.stop(true), 60_000).unref?.(); } catch {} }
    const opener = (await import("./platform.ts")).opener(target); // open on macOS, xdg-open on a Linux desktop, the URL handler on Windows
    let opened = false; if (opener && !argv.includes("--print") && process.env.KITEBOOK_NO_OPEN !== "1") { try { const p = Bun.spawn(opener, { stdout: "ignore", stderr: "ignore" }); opened = (await p.exited) === 0; } catch {} }
    const life = dev ? "60 seconds" : "5 minutes";
    if (opened && srv) { console.log("Opened your Kitebook in the browser, signed in as this device (that browser stays signed in while you use it; revoking this device signs it out)."); await Promise.race([hit, Bun.sleep(60_000)]); srv.stop(true); return 0; }
    console.log(opened ? `Opened your Kitebook in the browser, signed in (that browser stays signed in for 30 days).\nIf it opened somewhere else, paste this link where you want it, within ${life} (it works once):\n${r.url}`
      : `Open this link in the browser you want to sign in, within ${life} (it works once; that browser stays signed in for 30 days):\n${r.url}`);
    return 0; }
  close(); rmSync(base + ".req", { force: true }); console.error("kitebook open: the runner didn't answer. Is it running? Start it with: kitebook start"); return 1;
}
// runner side: answer `kitebook open` requests (only from processes outside this runner's own tree)
export function openWatch(mint: (q: { to?: string | null; nh?: string }) => Promise<string>, log: (...x: any[]) => void, audit: (e: any) => void) {
  return setInterval(async () => { let fs: string[]; try { fs = readdirSync(askDir()).filter(f => /^open\.\d+\.req$/.test(f)); } catch { return; }
    for (const f of fs) { const p = join(askDir(), f), base = p.slice(0, -4); let q: any, bad: string | null = null; try { q = JSON.parse(readFileSync(p, "utf8")); bad = checkAnswerer(p, q, false); rmSync(p); } catch { continue; }
      const res = (r: any) => { try { writeFileSync(base + ".res", JSON.stringify(r), { mode: 0o600 }); } catch {} };
      if (!Number.isInteger(q?.pid) || Date.now() - Number(q.at) > 30_000) continue;
      if (bad) { log("refused kitebook open:", bad); audit({ type: "open_refused", pid: q.pid, why: bad.slice(9, 80) }); res({ error: bad }); continue; }
      try { res({ url: await mint(q) }); audit({ type: "open_link", pid: q.pid }); log("kitebook open: made a single-use sign-in link"); } catch (e: any) { res({ error: e.message }); } } }, 700);
}
// the "Open dashboard" hook for a tray/menu-bar item or Settings button: the same signed one-time link as `kitebook open` (device-signed,
// nonce-bound, opened through the one-shot loopback redirect), so a click never needs a password or a pasted key
export const openDashboard = (to?: "settings") => openCli(to === "settings" ? ["--settings"] : []);
