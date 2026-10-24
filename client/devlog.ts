// The Mac's side of Experimental's recent logs/errors (src/devlog.ts is the server's). The runner keeps a bounded ring of its own lines and
// errors in ~/.kitebook/logs/devlog.jsonl (redacted before they touch the disk, survives restarts, compacted to the newest CAP.lines lines
// and CAP.errors errors per source once it passes CAP.bytes) and, only while the owner's Experimental is on (the policy settings-sync already
// verifies every pass), sends what's new to the server (runner op logs_report) so the owner's apps can read it with relay_logs.
// Experimental off: nothing leaves the Mac; the owner reads it with `kitebook logs --errors` (client/service.ts).
// Sources: "updates" for the updater / git pull / host upgrade lines, "runner" for the rest. Level: console.error = error, console.warn =
// warn, a line that says error/failed/crash/exception = error, else info. Uncaught errors are kept with their stack, then the runner exits
// as before (launchd / systemd / the supervisor start it again).
import { appendFileSync, readFileSync, writeFileSync, renameSync, statSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { format } from "util";
import { redactLog } from "./redact.ts";

export const CAP = { lines: 500, errors: 200, bytes: 512 * 1024, msg: 2000, stack: 4000 };
export type LEntry = { n: number; ts: number; level: "debug" | "info" | "warn" | "error"; source: "runner" | "updates"; msg: string; stack?: string };
export const ringFile = (home = homedir()) => join(home, ".kitebook", "logs", "devlog.jsonl");

export function classify(line: string, level?: string): { level: LEntry["level"]; source: LEntry["source"] } {
  const source = /\b(updates?|updated|updater|updating|release|upgrade|upgrading|git pull|fast-forward(ed)?|rollback|rolled back)\b/i.test(line) ? "updates" : "runner";
  const lv = level === "error" || level === "warn" ? level : /\b(error|errors|failed|failure|crash(ed)?|uncaught|exception|unhandled)\b/i.test(line) ? "error" : level === "debug" ? "debug" : "info";
  return { level: lv as LEntry["level"], source };
}
let seq = 0; const nextN = () => Date.now() * 1000 + (seq = (seq + 1) % 1000);
const cut = (s: string, n: number) => s.length > n ? s.slice(0, n) + "…" : s;

export class Ring {
  constructor(public file = ringFile(), public known: () => string[] = () => []) {}
  add(level: string | undefined, msg: string, stack?: string | null, source?: LEntry["source"]): LEntry | null {
    const k = this.known(), m = cut(redactLog(msg, k), CAP.msg).trim(); if (!m && !stack) return null;
    const c = classify(msg, level), e: LEntry = { n: nextN(), ts: Date.now(), level: c.level, source: source ?? c.source, msg: m, ...(stack ? { stack: cut(redactLog(stack, k), CAP.stack) } : {}) };
    try { mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 }); appendFileSync(this.file, JSON.stringify(e) + "\n", { mode: 0o600 });
      if (statSync(this.file).size > CAP.bytes) this.compact(); } catch {}
    return e;
  }
  all(): LEntry[] { let t = ""; try { t = readFileSync(this.file, "utf8"); } catch { return []; }
    const out: LEntry[] = []; for (const l of t.split("\n")) { if (!l) continue; try { const e = JSON.parse(l); if (e && typeof e.n === "number") out.push(e); } catch {} } return out; }
  // rotation: keep the newest per source, errors counted apart (a chatty log never pushes an error out), written atomically
  compact() { const all = this.all(), keep = new Set<number>();
    for (const src of ["runner", "updates"]) for (const err of [true, false]) all.filter(e => e.source === src && (e.level === "error") === err).slice(-(err ? CAP.errors : CAP.lines)).forEach(e => keep.add(e.n));
    const tmp = this.file + ".tmp"; writeFileSync(tmp, all.filter(e => keep.has(e.n)).map(e => JSON.stringify(e) + "\n").join(""), { mode: 0o600 }); renameSync(tmp, this.file); }
  after(n: number) { return this.all().filter(e => e.n > n); }
}

// the runner's own secrets, for redaction: its token, the ntfy token, the agent env keys it passes (cfg.env / envFile), anything key-ish in its env
export function knownSecrets(cfg: any): string[] {
  const out = [cfg?.token, cfg?.ntfy?.token].filter((x: any) => typeof x === "string") as string[];
  for (const k of Array.isArray(cfg?.env) ? cfg.env : []) { const v = process.env[String(k)]; if (v) out.push(v); }
  try { if (cfg?.envFile) for (const l of readFileSync(String(cfg.envFile).replace(/^~(?=\/)/, homedir()), "utf8").split("\n")) { const m = l.match(/^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*["']?(.*?)["']?\s*$/); if (m?.[1]) out.push(m[1]); } } catch {}
  for (const [k, v] of Object.entries(process.env)) if (v && v.length >= 12 && /SECRET|TOKEN|_KEY|PASS|CRED/i.test(k) && !/^https?:\/\//.test(v)) out.push(v);
  return out.filter(v => v.length >= 8);
}

// Hook console.* (the runner's log() is console.log) and uncaught errors into the ring; what's printed is unchanged.
export function hookConsole(ring: Ring) {
  let busy = false; const orig = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const [name, level] of [["log", "info"], ["info", "info"], ["warn", "warn"], ["error", "error"]] as const) {
    (console as any)[name] = (...a: any[]) => { (orig as any)[name](...a); if (busy) return; busy = true;
      try { const err = a.find(x => x instanceof Error) as Error | undefined; ring.add(level, format(...a.map(x => x instanceof Error ? x.message : x)), err?.stack ?? null); } catch {} finally { busy = false; } };
  }
  const fatal = (kind: string) => (e: any) => { try { ring.add("error", `${kind}: ${String(e?.message ?? e)}`, typeof e?.stack === "string" ? e.stack : null); } catch {}
    orig.error(e); process.exit(1); }; // what bun does by itself for both: print and exit 1 (the service manager restarts the runner)
  process.on("uncaughtException", fatal("uncaught exception")); process.on("unhandledRejection", fatal("unhandled rejection"));
  return orig;
}

// Sending: while Experimental is on, whatever the server hasn't got yet (cursor file per workspace), at most 200 per call. A send that fails is
// retried on the next pass; its failure goes to the real stderr only (never back into the ring, which would loop).
export function startDevlog(o: { cfg: () => any; call: (op: string, a?: any) => Promise<any>; space: string; home?: string; log?: (...a: any[]) => void }) {
  const home = o.home ?? homedir(), ring = new Ring(ringFile(home), () => knownSecrets(o.cfg()));
  const orig = hookConsole(ring), curFile = join(home, ".kitebook", "logs", `devlog-sent-${o.space.replace(/[^\w.-]/g, "_")}.txt`);
  let on: boolean | null = null, sending = false;
  const cursor = () => { try { return Number(readFileSync(curFile, "utf8")) || 0; } catch { return 0; } };
  async function send() { if (sending) return; sending = true;
    try { for (let i = 0; i < 10; i++) { const todo = ring.after(cursor()).slice(0, 200); if (!todo.length) break;
      const r = await o.call("logs_report", { entries: todo.map(({ ts, level, source, msg, stack }) => ({ ts, level, source, msg, stack })) }); if ((r?.experimental ?? r?.dev) === false) break; // dev: the old server's name
      writeFileSync(curFile, String(todo[todo.length - 1].n), { mode: 0o600 }); } }
    catch (e: any) { orig.error(new Date().toISOString().slice(11, 19), "recent logs not sent:", e?.message ?? e); } finally { sending = false; } }
  return { ring,
    // settings-sync calls this every pass with the owner-signed Experimental state
    experimental(now: boolean) { if (now && on !== true) { (o.log ?? console.log)("Experimental is on: this Mac's recent log lines go to your Kitebook (secrets hidden) so your apps can read them with relay_logs");
        if (!existsSync(curFile)) try { mkdirSync(dirname(curFile), { recursive: true }); writeFileSync(curFile, "0"); } catch {} }
      if (!now && on === true) (o.log ?? console.log)("Experimental is off: recent log lines stay on this Mac (read them with kitebook logs)");
      on = now; if (now) send(); } };
}

// `kitebook logs --errors [--source server|auth|runner|updates|all] [--since 2h] [--level warn] [-n 50] [--json]` (the owner, on their Mac;
// works whether Experimental is on or off): the server's ring (relay_logs with this Mac's runner token) next to this Mac's own ring.
export async function logsCli(cfg: any, argv: string[], home = homedir()): Promise<number> {
  const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const source = opt("--source") ?? "all", since = opt("--since"), level = opt("--level") ?? (argv.includes("--errors") ? "error" : undefined), limit = Math.min(500, Number(opt("-n") ?? opt("--limit")) || 50);
  let server: any[] = [], why = "";
  if (cfg?.url && cfg?.token) try {
    const r = await fetch(`${String(cfg.url).replace(/\/$/, "")}/v1/relay_logs`, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" },
      body: JSON.stringify({ space: cfg.space, source, since, level, limit }), signal: AbortSignal.timeout(15_000) });
    const j: any = await r.json().catch(() => null); if (j?.ok) server = j.result.entries.filter((e: any) => !(e.runner && e.runner === cfg.name)); else why = j?.error ?? `the server answered ${r.status}`;
  } catch (e: any) { why = `couldn't reach ${cfg.url} (${e?.message ?? e})`; }
  else why = "no url/token in runner.json";
  const lv = ["debug", "info", "warn", "error"], min = level ? lv.indexOf(level) : 0;
  if (min < 0) { console.error("level: debug | info | warn | error"); return 2; }
  let s: number | null = null; try { if (since) { const m = String(since).match(/^(\d+)\s*([smhd])$/); s = m ? Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2] as "s"] : /^\d+$/.test(since) ? Number(since) : Date.parse(since); if (!Number.isFinite(s)) throw 0; } } catch { console.error("since: an ISO time, ms epoch, or an age like 15m, 2h, 3d"); return 2; }
  const local = ["all", "runner", "updates"].includes(source) ? new Ring(ringFile(home)).all().filter(e => (source === "all" || e.source === source) && lv.indexOf(e.level) >= min && (s == null || e.ts >= s))
    .map(e => ({ at: new Date(e.ts).toISOString(), source: e.source, level: e.level, msg: e.msg, ...(e.stack ? { stack: e.stack } : {}), runner: "this Mac", _k: e.n })) : [];
  const all = [...server.map((e: any) => ({ ...e, _k: e.id })), ...local].sort((a: any, b: any) => (b.at > a.at ? 1 : b.at < a.at ? -1 : b._k - a._k)).slice(0, limit).map(({ _k, ...e }: any) => e);
  if (argv.includes("--json")) { console.log(JSON.stringify({ entries: all, ...(why ? { server_error: why } : {}) }, null, 1)); return 0; }
  if (why) console.error(`kitebook: the server's recent errors aren't included: ${why}`);
  if (!all.length) { console.log(`No recent ${level ? level + (level === "error" ? "s" : "+ lines") : "lines"}${source !== "all" ? ` from ${source}` : ""}.`); return 0; }
  for (const e of all.reverse()) { // oldest first, like a log
    console.log(`${e.at.replace("T", " ").slice(0, 19)}  ${e.level.padEnd(5)}  ${String(e.source).padEnd(7)}  ${e.route ? e.route + (e.status ? " " + e.status : "") + "  " : ""}${e.msg}${e.request_id ? `  [${e.request_id}]` : ""}${e.runner && e.runner !== "this Mac" ? `  (${e.runner})` : ""}`);
    if (e.stack && e.level === "error") for (const l of String(e.stack).split("\n").slice(1, 4)) console.log("      " + l.trim());
  }
  return 0;
}
