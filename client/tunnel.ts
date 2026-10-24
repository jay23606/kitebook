// No server, no domain (G6): Kitebook's own server runs on this Mac (cf dev / workerd, scripts/mac-host.sh) and a built-in tunnel gives it a
// public HTTPS address, with no Cloudflare account, no domain and no port opened on the router.
//   quick (default)  cloudflared's free quick tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>` -> https://<words>.trycloudflare.com.
//                    Free and zero-setup, but the address changes when the tunnel restarts (Settings -> Connection shows the new one).
//   named            the owner's own Cloudflare tunnel (one token + its hostname, pasted in Settings -> Connection or `kitebook tunnel token`):
//                    the same address forever. The token goes to cloudflared in its environment (TUNNEL_TOKEN), never on a command line.
// Either way the tunnel only forwards HTTPS to the local server (127.0.0.1:<port>), and every request still needs the same sign-in as
// anywhere else: /admin needs the ADMIN_TOKEN, ops need a token, pages need the owner's session. Nothing new is opened.
// cloudflared: an installed one (brew) or a pinned release downloaded once into ~/.kitebook/bin, sha256-checked (archive and binary)
// against the hashes below before it ever runs; a mismatch refuses to start.
// The supervisor (`kitebook tunnel run`, kept alive by launchd dev.kitebook.tunnel / systemd kitebook-tunnel / Kitebook's supervisor on Windows) runs cloudflared, reads its address
// from cloudflared's log, restarts it with backoff, and every few seconds reports to the local server (admin op tunnel_report, the
// ADMIN_TOKEN from the server's .dev.vars), which hands back what the owner pressed in Settings (Restart tunnel, a token). When the address
// changes it is recorded (previous + when) for Settings, and a runner on this Mac still pointed at an old tunnel address is moved to the
// local address (http://127.0.0.1:<port>, which never changes) and restarted once idle.
// State: ~/.kitebook/tunnel.json (settings, 0600: may hold the token) and tunnel-state.json (what `kitebook status`, doctor and Settings show).
//   kitebook tunnel [status]        plain words: address, health, mode        kitebook tunnel restart   new cloudflared (quick: a new address)
//   kitebook tunnel url [--wait s]  print the public address once it's up      kitebook tunnel token <token> <hostname>   keep one address
//   kitebook tunnel quick           back to the free quick tunnel              kitebook tunnel run [--port p] [--server-dir d]   the supervisor
//   kitebook tunnel install [--port p] [--server-dir d]   Windows / Linux: the helper as a service (the installers run it; `on` runs it if missing)
//   kitebook tunnel off | on        public access off (the one-step install starts this way: only this Mac reaches Kitebook) or back on;
//                                Settings -> Connection has the same switch. Off, the helper keeps running and reporting, cloudflared doesn't.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, rmSync, renameSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir, tmpdir } from "os";
import { createHash } from "crypto";
import { machine } from "./platform.ts";

export const home = () => join(process.env.HOME || homedir(), ".kitebook");
const cfgFile = () => join(home(), "tunnel.json"), stateFile = () => join(home(), "tunnel-state.json"), flagFile = () => join(home(), "tunnel-restart");
// cloudflared 2026.10.1 (github.com/cloudflare/cloudflared/releases): file sha256 = the release asset, bin = the binary inside a .tgz
export const CLOUDFLARED = { version: "2026.10.1", base: "https://github.com/cloudflare/cloudflared/releases/download/2026.10.1/", assets: {
  "darwin-arm64": { file: "cloudflared-darwin-arm64.tgz", sha256: "647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc", bin: "35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9" },
  "darwin-amd64": { file: "cloudflared-darwin-amd64.tgz", sha256: "3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab", bin: "8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede" },
  "linux-amd64": { file: "cloudflared-linux-amd64", sha256: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586", bin: "3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586" },
  "linux-arm64": { file: "cloudflared-linux-arm64", sha256: "2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46", bin: "2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46" },
  "windows-amd64": { file: "cloudflared-windows-amd64.exe", sha256: "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6", bin: "4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6" },
} as Record<string, { file: string; sha256: string; bin: string }> };
export const TOKEN_RE = /^[A-Za-z0-9+/=_-]{40,4096}$/, HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export type TState = { mode: "quick" | "named" | "off"; state: "starting" | "up" | "down" | "stopped"; url: string | null; previous: string | null; changed_at: string | null;
  since: string; error: string | null; restarts: number; seen: string[]; pid: number | null; supervisor: number | null; port: number; hostname: string | null; local: string };
const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return null; } };
const writeJson = (f: string, v: any, mode = 0o600) => { mkdirSync(home(), { recursive: true, mode: 0o700 }); const t = f + ".tmp"; writeFileSync(t, JSON.stringify(v, null, 2), { mode }); chmodSync(t, mode); renameSync(t, f); };
export const readConfig = (): any => readJson(cfgFile()) ?? {};
export const readState = (): TState | null => readJson(stateFile());
const alive = (pid: number | null | undefined) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; } };
// public access off: the helper runs on (reporting, waiting for the switch) with cloudflared stopped, so "stopped" is its normal state then
export const supervisorUp = (s = readState()) => !!s && (s.state !== "stopped" || s.mode === "off") && alive(s.supervisor);

// One line of cloudflared's log: the quick tunnel's address (never api.trycloudflare.com, which shows up in its errors), a connection
// to Cloudflare's edge (the tunnel works), or an error worth showing the owner in plain words.
export function parseLine(l: string): { url?: string; connected?: boolean; error?: string } {
  const out: { url?: string; connected?: boolean; error?: string } = {};
  const u = l.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/i); if (u) out.url = u[0].toLowerCase();
  if (/Registered tunnel connection|Connection [0-9a-f-]+ registered/i.test(l)) out.connected = true;
  const e = l.match(/\b(?:ERR|FTL|error)\b[: ]+(.*)$/i); if (e && !out.url) out.error = e[1].replace(/\s+/g, " ").trim().slice(0, 240);
  return out;
}
// Plain words for the owner (kitebook status, doctor, Settings mirrors this in its own words)
export function describe(s: TState | null): { ok: boolean; line: string } {
  if (!s) return { ok: true, line: "not used (this Kitebook has its own address)" };
  if (s.mode === "off") return supervisorUp(s) ? { ok: true, line: `public access is off: only this ${machine()} reaches Kitebook. Turn it on in Settings -> Connection (or: kitebook tunnel on)` } : { ok: false, line: "public access is off, and the tunnel helper isn't running. Try: kitebook restart tunnel" };
  const kind = s.mode === "named" ? "your Cloudflare tunnel, a fixed address" : "free quick tunnel; the address changes when it restarts";
  if (s.state === "stopped") return { ok: false, line: `stopped. Start it: kitebook start tunnel` };
  if (!supervisorUp(s)) return { ok: false, line: `DOWN: the tunnel helper isn't running. Try: kitebook restart tunnel (then kitebook logs tunnel)` };
  if (s.state === "up" && s.url) return { ok: true, line: `up: ${s.url} (${kind})` };
  if (s.state === "starting") return { ok: true, line: `starting (${kind})` };
  return { ok: false, line: `DOWN${s.error ? `: ${s.error}` : ""}. It retries by itself; or: kitebook restart tunnel` };
}

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
// Windows: cloudflared-windows-amd64.exe (Windows on Arm runs it under its x64 emulation; there is no arm64 build)
export const platformKey = (p: string = process.platform, arch: string = process.arch) => p === "win32" ? "windows-amd64" : `${p}-${arch === "x64" ? "amd64" : arch}`;
const exeName = () => process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
// The cloudflared to run: runner config "bin" / KITEBOOK_CLOUDFLARED (an exact file), one on PATH (brew install cloudflared), else the pinned
// release in ~/.kitebook/bin (downloaded once, checked every start). KITEBOOK_CLOUDFLARED_URL + KITEBOOK_CLOUDFLARED_SHA256 swap the release
// (a mirror, or a test); without a hash it is refused.
export async function ensureBinary(o: { bin?: string; log?: (s: string) => void } = {}): Promise<string> {
  const log = o.log ?? (() => {}), want = o.bin || process.env.KITEBOOK_CLOUDFLARED;
  if (want) { if (!existsSync(want)) throw new Error(`cloudflared not found at ${want}`); return want; }
  const onPath = Bun.which("cloudflared"); if (onPath && !process.env.KITEBOOK_CLOUDFLARED_URL) return onPath;
  const custom = process.env.KITEBOOK_CLOUDFLARED_URL, a = custom ? { file: custom.split("/").pop()!, sha256: String(process.env.KITEBOOK_CLOUDFLARED_SHA256 ?? "").toLowerCase(), bin: String(process.env.KITEBOOK_CLOUDFLARED_BIN_SHA256 ?? "").toLowerCase() } : CLOUDFLARED.assets[platformKey()];
  if (!a) throw new Error(`no cloudflared release for ${platformKey()}: install cloudflared yourself (it's used from your PATH)`);
  if (!/^[0-9a-f]{64}$/.test(a.sha256)) throw new Error("KITEBOOK_CLOUDFLARED_URL needs KITEBOOK_CLOUDFLARED_SHA256 (the file's sha256); refusing an unchecked download");
  const dest = join(home(), "bin", exeName()), tgz = a.file.endsWith(".tgz");
  if (existsSync(dest) && (!a.bin || sha(readFileSync(dest)) === a.bin) && (a.bin || !custom)) return dest; // already here and still the pinned binary
  const url = custom ?? CLOUDFLARED.base + a.file; log(`downloading cloudflared ${custom ? "" : CLOUDFLARED.version + " "}from ${url}`);
  const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120_000) }); if (!r.ok) throw new Error(`couldn't download cloudflared (${r.status} from ${url})`);
  const buf = new Uint8Array(await r.arrayBuffer()), got = sha(buf);
  if (got !== a.sha256) throw new Error(`cloudflared download checksum mismatch (got ${got.slice(0, 16)}…, expected ${a.sha256.slice(0, 16)}…): refusing to run it`);
  mkdirSync(join(home(), "bin"), { recursive: true, mode: 0o700 });
  let bin = buf;
  if (tgz) { const d = join(tmpdir(), `kitebook-cfd-${process.pid}-${Date.now()}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "a.tgz"), buf);
    const x = Bun.spawnSync(["tar", "-xzf", join(d, "a.tgz"), "-C", d], { stdout: "pipe", stderr: "pipe" });
    if (x.exitCode || !existsSync(join(d, "cloudflared"))) { rmSync(d, { recursive: true, force: true }); throw new Error("couldn't unpack the cloudflared download"); }
    bin = new Uint8Array(readFileSync(join(d, "cloudflared"))); rmSync(d, { recursive: true, force: true }); }
  if (a.bin && sha(bin) !== a.bin) throw new Error("cloudflared binary checksum mismatch inside the download: refusing to run it");
  writeFileSync(dest + ".tmp", bin, { mode: 0o755 }); chmodSync(dest + ".tmp", 0o755); renameSync(dest + ".tmp", dest); log(`cloudflared installed at ${dest} (sha256 checked)`);
  return dest;
}

const adminToken = (dir?: string) => process.env.KITEBOOK_ADMIN_TOKEN || (dir ? (readFileSync(join(dir, ".dev.vars"), "utf8").match(/^ADMIN_TOKEN=(.*)$/m)?.[1] ?? "").trim() : "");
const nowIso = () => new Date().toISOString();

// A runner on this Mac that still points at an old tunnel address is moved to the local one (it never changes) and restarts once idle;
// coding agents' JSON configs (Cursor, Gemini CLI, opencode) follow. Nothing else in runner.json changes.
export async function propagate(seen: string[], local: string, log: (s: string) => void): Promise<boolean> {
  const f = process.env.KITEBOOK_RUNNER_CONFIG || join(home(), "runner.json"), c = readJson(f);
  if (!c?.url || c.url === local) return false;
  const u = String(c.url).replace(/\/+$/, ""); if (!seen.includes(u)) return false; // only this Kitebook's own tunnel addresses
  c.url = local; writeJson(f, c); try { const { stampOwnerEdit } = await import("./guard.ts"); stampOwnerEdit(f); } catch {}
  try { writeFileSync(join(home(), "restart-runner"), nowIso()); } catch {}
  try { const { refreshConfigs } = await import("./agents-connect.ts"); refreshConfigs(local); } catch {}
  log(`runner on this ${machine()} now uses ${local} (was ${u}); it restarts once its tasks finish`); return true;
}

// ---- the supervisor ----
// the server's public edge listener (src/ingress.ts): KITEBOOK_EDGE_PORT, else the local port + 1
export const edgeUrl = (port: number) => `http://127.0.0.1:${Number(process.env.KITEBOOK_EDGE_PORT) || port + 1}`;
async function edgeTarget(port: number): Promise<string> {
  const e = edgeUrl(port); return await fetch(`${e}/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false) ? e : `http://127.0.0.1:${port}`;
}
const modeOf = (c: any): TState["mode"] => c.mode === "off" ? "off" : c.mode === "named" && c.token ? "named" : "quick";
export async function supervise(o: { port: number; serverDir?: string; bin?: string }): Promise<never> {
  const log = (...a: any[]) => console.log(`[${nowIso()}] tunnel:`, ...a);
  const local = `http://127.0.0.1:${o.port}`, reportEvery = Number(process.env.KITEBOOK_TUNNEL_REPORT_MS ?? 5000) || 5000;
  const probeEvery = Number(process.env.KITEBOOK_TUNNEL_PROBE_MS ?? 60_000); // 0 = don't check the public address from here
  const old = readState();
  let cfg = { ...readConfig(), port: o.port, ...(o.serverDir ? { serverDir: o.serverDir } : {}) }; writeJson(cfgFile(), cfg);
  const st: TState = { mode: modeOf(cfg), state: "starting", url: null, previous: old?.url ?? old?.previous ?? null, changed_at: old?.changed_at ?? null,
    since: nowIso(), error: null, restarts: 0, seen: (old?.seen ?? []).slice(-20), pid: null, supervisor: process.pid, port: o.port, hostname: cfg.hostname ?? null, local };
  let lastUrl: string | null = old?.url ?? null, child: any = null, connected = false, stopping = false, backoff = 0, timer: any = null, probeFails = 0;
  const save = () => writeJson(stateFile(), st);
  const report = async () => { const t = adminToken(cfg.serverDir); if (!t) return;
    try { const r: any = await (await fetch(`${local}/admin/tunnel_report`, { method: "POST", headers: { authorization: `Bearer ${t}`, "content-type": "application/json" }, body: JSON.stringify({ ...st, hostname: st.hostname }), signal: AbortSignal.timeout(4000) })).json();
      const ask = r?.result?.ask; if (ask) await onAsk(ask); } catch {} };
  const setUrl = async (u: string) => { st.url = u; if (!st.seen.includes(u)) st.seen = [...st.seen, u].slice(-20); if (u !== lastUrl) { if (lastUrl) { st.previous = lastUrl; st.changed_at = nowIso(); log(`public address changed: ${lastUrl} -> ${u}`); } else log(`public address: ${u}`);
    lastUrl = u; } };
  const start = async () => {
    if (stopping) return; connected = false;
    if (st.mode === "off") { st.state = "stopped"; st.error = null; st.url = null; st.pid = null; st.since = nowIso(); save(); log("public access is off (Settings -> Connection, or kitebook tunnel on)"); return; } st.state = "starting"; st.error = null; st.url = null; st.since = nowIso(); save();
    let bin: string; try { bin = await ensureBinary({ bin: cfg.bin, log }); } catch (e: any) { st.state = "down"; st.error = e.message; save(); log(e.message); return later(); }
    // the edge listener; a server from before it has none: the local port (the tunnel's headers make every request edge there)
    const target = await edgeTarget(o.port), named = st.mode === "named" && cfg.token, argv = named ? [bin, "tunnel", "--no-autoupdate", "run"] : [bin, "tunnel", "--no-autoupdate", "--url", target];
    log(`starting ${named ? `your Cloudflare tunnel (${cfg.hostname})` : "a quick tunnel"} -> ${named ? "the hostname's service set in Cloudflare (point it at " + edgeUrl(o.port) + ")" : target}`);
    child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", windowsHide: true, env: { ...process.env, ...(named ? { TUNNEL_TOKEN: cfg.token } : {}) } } as any); st.pid = child.pid; save();
    const me = child;
    const read = async (s: ReadableStream) => { let buf = ""; const dec = new TextDecoder();
      for await (const chunk of s as any) { buf += dec.decode(chunk, { stream: true }); let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); await onLine(line, me); } } };
    read(child.stdout); read(child.stderr);
    child.exited.then((code: number) => { if (me !== child) return; child = null; st.pid = null; if (stopping) return;
      st.state = "down"; st.error ??= `cloudflared stopped (exit ${code})`; save(); log(`cloudflared exited (${code}); retrying`); report(); later(); });
  };
  const onLine = async (line: string, me: any) => { if (me !== child) return; const p = parseLine(line);
    if (p.url && st.mode === "quick") await setUrl(p.url);
    if (p.connected && !connected) { connected = true; if (st.mode === "named" && cfg.hostname) await setUrl(`https://${cfg.hostname}`);
      if (st.url) { st.state = "up"; st.error = null; backoff = 0; probeFails = 0; save(); log(`up: ${st.url}`); report(); propagate(st.seen, local, log).catch(() => {}); } }
    if (p.error && st.state !== "up") { st.error = p.error; save(); } };
  const later = () => { clearTimeout(timer); const d = [1, 2, 5, 10, 30, 60][Math.min(backoff++, 5)] * 1000; timer = setTimeout(start, d); };
  const restart = async (why: string) => { log(`restarting: ${why}`); st.restarts++; clearTimeout(timer); backoff = 0;
    const c = child; child = null; st.pid = null; if (c) { c.kill(); await Promise.race([c.exited, Bun.sleep(5000)]); try { c.kill(9); } catch {} } await start(); report(); };
  // a new hostname restarts the local server once, as a service (workerd answers any Host; it once mattered for cf dev's allowedHosts,
  // which now refuses every tunnel host: production is workerd, scripts/serve.sh)
  const serverFor = (host: string) => { if (!cfg.serverDir) return; log(`restarting the server so it answers on ${host}`);
    import("./service.ts").then(S => S.service(process.env.KITEBOOK_RUNNER_CONFIG || join(home(), "runner.json"), ["restart", "server"], { plain: true })).catch(e => log(`server restart: ${e.message}`)); };
  const onAsk = async (ask: any) => {
    if (ask.token && TOKEN_RE.test(ask.token) && HOST_RE.test(String(ask.hostname ?? ""))) { const was = cfg.hostname; cfg = { ...cfg, mode: "named", token: ask.token, hostname: ask.hostname }; writeJson(cfgFile(), cfg); st.mode = "named"; st.hostname = ask.hostname;
      if (was !== ask.hostname) serverFor(ask.hostname); return restart("your Cloudflare tunnel was added in Settings"); }
    if (ask.off) { cfg = { ...cfg, mode: "off" }; writeJson(cfgFile(), cfg); st.mode = "off"; return restart("public access turned off (Settings)"); }
    if (ask.on) { cfg = { ...cfg, mode: cfg.token && cfg.hostname ? "named" : "quick" }; writeJson(cfgFile(), cfg); st.mode = modeOf(cfg); return restart("public access turned on (Settings)"); }
    if (ask.quick) { const { token, hostname, ...rest } = cfg; cfg = { ...rest, mode: "quick" }; writeJson(cfgFile(), cfg); st.mode = "quick"; st.hostname = null; st.url = null; return restart("back to the quick tunnel (Settings)"); }
    if (ask.restart) return restart("Restart tunnel was pressed in Settings");
  };
  const stop = () => { stopping = true; st.state = "stopped"; st.pid = null; save(); try { child?.kill(); } catch {} report().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); };
  process.on("SIGTERM", stop); process.on("SIGINT", stop);
  save(); await start(); report();
  // kitebook tunnel restart | token | quick (the owner's terminal) leave a flag; the settings file may have changed with it
  setInterval(() => { if (!existsSync(flagFile())) return; try { rmSync(flagFile()); } catch {}
    const was = cfg.hostname; cfg = { ...readConfig(), port: o.port, ...(o.serverDir ? { serverDir: o.serverDir } : {}) }; if (cfg.mode === "named" && cfg.hostname && cfg.hostname !== was) serverFor(cfg.hostname); st.mode = modeOf(cfg); st.hostname = st.mode === "named" ? cfg.hostname ?? null : null;
    restart("kitebook tunnel restart"); }, 1000);
  setInterval(report, reportEvery);
  if (probeEvery > 0) setInterval(async () => { if (st.state !== "up" || !st.url) return;
    const ok = await fetch(`${st.url}/health`, { signal: AbortSignal.timeout(10_000) }).then(r => r.ok, () => false);
    if (ok) { probeFails = 0; return; } if (++probeFails >= 3) { probeFails = 0; st.error = "the public address stopped answering"; restart("the public address stopped answering"); } }, probeEvery);
  return await new Promise<never>(() => {});
}

// ---- the helper as a service off macOS (macOS: scripts/mac-host.sh writes its launchd job) ----
// Windows and Linux: the kitebook-tunnel job under this OS's service tooling (Kitebook's supervisor, started at sign-in by a per-user
// Scheduled Task on Windows; systemd --user or the supervisor on Linux), the same as the server and the runner. A first install starts with
// public access off (only this computer reaches Kitebook); a later one keeps the owner's choice. The one-step installers run it
// (get.ps1, get.sh on Linux), and `kitebook tunnel on` runs it for an install from before that.
const runnerCfg = () => { try { return JSON.parse(readFileSync(process.env.KITEBOOK_RUNNER_CONFIG || join(home(), "runner.json"), "utf8")); } catch { return {}; } };
// where this computer's server is: runner.json's server (dir, health URL), else tunnel.json, else the installers' defaults
export function serverOf(c = runnerCfg(), t = readConfig()): { port: number; dir: string | null } {
  const h = String(c.server?.health ?? (/^http:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(String(c.url ?? "")) ? c.url : "")), m = h.match(/^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)/);
  return { port: Number(m?.[1] ?? t.port ?? process.env.PORT ?? 7820) || 7820, dir: c.server?.dir ?? t.serverDir ?? null };
}
export async function installHelper(o: { port: number; serverDir: string }): Promise<string> {
  if (!existsSync(join(o.serverDir, ".dev.vars"))) throw new Error(`${o.serverDir} isn't this computer's Kitebook server (no .dev.vars there)`);
  if (!existsSync(cfgFile())) writeJson(cfgFile(), { mode: "off", port: o.port, serverDir: o.serverDir });
  const c = runnerCfg(), { installJob } = await import("./runner-service.ts"), { UNIT } = await import("./brand.ts"), PL = await import("./platform.ts");
  if (process.env.KITEBOOK_SUPERVISE === "1") c.supervise = true; if (process.env.KITEBOOK_SYSTEMCTL) c.systemctl = process.env.KITEBOOK_SYSTEMCTL; // the installers' overrides (as client/jobs.ts)
  // the server checkout's own copy (as scripts/mac-host.sh does), run by bun (from a compiled kitebook binary: the bun on PATH)
  const self = existsSync(join(o.serverDir, "client", "tunnel.ts")) ? join(o.serverDir, "client", "tunnel.ts") : join(import.meta.dir, "tunnel.ts");
  const bun = /^bun(\.exe)?$/i.test(basename(process.execPath)) ? process.execPath : Bun.which("bun") ?? process.execPath;
  return await installJob(c.tunnelUnit ?? UNIT.tunnel, "Kitebook tunnel (public access for this computer)", [bun, self, "run", "--port", String(o.port), "--server-dir", o.serverDir], { PATH: PL.envPath() }, c, o.serverDir);
}
const helperInstalled = async () => { const c = runnerCfg(), { hasJob } = await import("./runner-service.ts"), { UNIT, LEGACY_UNIT } = await import("./brand.ts");
  return (await hasJob(c.tunnelUnit ?? UNIT.tunnel, c)) || (await hasJob(LEGACY_UNIT.tunnel, c)); };
const onMac = async () => (await import("./platform.ts")).plat() === "darwin" || !!process.env.KITEBOOK_FAKE_MAC;

// ---- kitebook tunnel ... (owner's terminal; status and restart also from kitebook-svc) ----
export async function tunnelCli(argv: string[]): Promise<number> {
  const [cmd = "status", ...rest] = argv, flag = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  const fromTask = !!process.env.KITEBOOK_TASK_ID;
  if (["run", "token", "quick", "on", "off", "install"].includes(cmd) && fromTask) { console.error(`kitebook tunnel ${cmd}: only the machine owner can change the tunnel (from their own terminal)`); return 1; }
  if (cmd === "run") { const c = readConfig(), port = Number(flag("--port") ?? c.port ?? process.env.PORT ?? 7820); if (!(port > 0)) { console.error("usage: kitebook tunnel run [--port 7820] [--server-dir <kitebook checkout>]"); return 2; }
    return await supervise({ port, serverDir: flag("--server-dir") ?? c.serverDir, bin: flag("--bin") }); }
  if (cmd === "status") { const s = readState();
    if (rest.includes("--json")) { console.log(JSON.stringify(s ? { ...s, healthy: describe(s).ok, supervisor_up: supervisorUp(s) } : null, null, 2)); return 0; }
    const d = describe(s); console.log(`tunnel   ${d.line}`);
    if (s) { console.log(`local    ${s.local} (this ${machine()}'s runner and coding agents use this; it never changes)`);
      if (s.url) console.log(`connect  Claude.ai / ChatGPT: ${s.url}/mcp   (Settings -> Connection has a Copy button)`);
      if (s.previous && s.changed_at) console.log(`changed  ${s.changed_at.slice(0, 16).replace("T", " ")} UTC from ${s.previous}: re-add assistants that used the old address`); }
    return d.ok ? 0 : 1; }
  if (cmd === "url") { const wait = Number(flag("--wait") ?? 0) * 1000, t0 = Date.now();
    for (;;) { const s = readState(); if (s?.state === "up" && s.url) { console.log(s.url); return 0; } if (Date.now() - t0 >= wait) break; await Bun.sleep(500); }
    console.error(`kitebook tunnel: no public address yet (${describe(readState()).line})`); return 1; }
  if (cmd === "restart") { const s = readState(), was = s?.since;
    if (!supervisorUp(s)) { const { service } = await import("./service.ts"); return await service(process.env.KITEBOOK_RUNNER_CONFIG || join(home(), "runner.json"), ["restart", "tunnel"], { plain: true }); }
    writeFileSync(flagFile(), nowIso()); const t0 = Date.now();
    while (Date.now() - t0 < 30_000) { await Bun.sleep(500); const n = readState(); if (n && n.since !== was && n.state === "up") { console.log(`tunnel: restarted, up: ${n.url}${n.mode === "quick" && n.url !== s?.url ? " (a new address: Settings -> Connection has it to copy)" : ""}`); return 0; } }
    console.log(`tunnel: restart asked; ${describe(readState()).line}`); return 1; }
  if (cmd === "token") { const [tok, host] = rest; if (!tok || !TOKEN_RE.test(tok) || !HOST_RE.test(String(host ?? "").toLowerCase())) { console.error("usage: kitebook tunnel token <cloudflare tunnel token> <hostname, e.g. kitebook.example.com>\n(In Cloudflare: Zero Trust -> Networks -> Tunnels -> Create, then point that hostname at http://localhost:<port>.)"); return 2; }
    writeJson(cfgFile(), { ...readConfig(), mode: "named", token: tok, hostname: host.toLowerCase() }); writeFileSync(flagFile(), nowIso());
    console.log(`tunnel: using your Cloudflare tunnel at https://${host.toLowerCase()} (fixed address)${supervisorUp() ? "; restarting it now" : "; start it: kitebook start tunnel"}`); return 0; }
  if (cmd === "quick") { const { token, hostname, ...c } = readConfig(); writeJson(cfgFile(), { ...c, mode: "quick" }); writeFileSync(flagFile(), nowIso());
    console.log(`tunnel: back to the free quick tunnel (its address changes when it restarts)${supervisorUp() ? "; restarting it now" : ""}`); return 0; }
  if (cmd === "install") { if (await onMac()) { console.error("kitebook tunnel install: on a Mac the tunnel helper comes with the server (run the one-step install again: scripts/get.sh)"); return 1; }
    const sv = serverOf(), port = Number(flag("--port") ?? sv.port), dir = flag("--server-dir") ?? sv.dir;
    if (!dir || !(port > 0)) { console.error("usage: kitebook tunnel install [--port 7820] --server-dir <the Kitebook checkout that runs the server>"); return 2; }
    try { console.log(`tunnel helper installed: ${await installHelper({ port, serverDir: dir })}. Public access is ${modeOf(readConfig()) === "off" ? "off (kitebook tunnel on, or Settings -> Connection)" : "on"}`); return 0; }
    catch (e: any) { console.error(`kitebook tunnel install: ${e.message}`); return 1; } }
  // `on` with no helper yet (Windows or Linux, an install from before the installers set it up): set it up first, public access on
  if (cmd === "on" && !supervisorUp() && !(await onMac()) && !(await helperInstalled())) { const sv = serverOf();
    if (!sv.dir) { console.error("kitebook tunnel on: this computer doesn't run a Kitebook server (no server dir in runner.json), so there is nothing to make public here"); return 1; }
    const c = readConfig(); writeJson(cfgFile(), { ...c, port: sv.port, serverDir: sv.dir, mode: c.token && c.hostname ? "named" : "quick" });
    try { await installHelper({ port: sv.port, serverDir: sv.dir }); } catch (e: any) { console.error(`kitebook tunnel on: couldn't set up the tunnel helper (${e.message})`); return 1; }
    console.log("tunnel: public access on; the tunnel helper is set up and starting (it downloads cloudflared once, sha256-checked). The address shows in a few seconds: kitebook tunnel"); return 0; }
  if (cmd === "off" || cmd === "on") { const c = readConfig(); writeJson(cfgFile(), { ...c, mode: cmd === "off" ? "off" : c.token && c.hostname ? "named" : "quick" }); writeFileSync(flagFile(), nowIso());
    console.log(cmd === "off" ? `tunnel: public access off; only this ${machine()} reaches Kitebook now` : `tunnel: public access on${supervisorUp() ? "; the address shows in a few seconds (kitebook tunnel)" : "; start it: kitebook start tunnel"}`); return 0; }
  console.error("usage: kitebook tunnel [status [--json] | on | off | restart | url [--wait s] | token <token> <hostname> | quick | install [--port p] [--server-dir d] | run [--port p] [--server-dir d]]"); return 2;
}
// no top-level await: the supervisor never returns, and service.ts imports this module from inside it (a pending await would deadlock that import)
if (import.meta.main) (await import("./rebrand.ts")).migrateDirs(); // an install from before the rename: its folders take the new names first (client/rebrand.ts)
if (import.meta.main) tunnelCli(process.argv.slice(2)).then(c => process.exit(c), e => { console.error(`kitebook tunnel: ${e.message}`); process.exit(1); });
