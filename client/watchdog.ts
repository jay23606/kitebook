// The runner's watchdog: `bun watchdog.ts <runner.json>`, run once a minute by launchd (dev.kitebook.watchdog, StartInterval 60;
// client/runner-service.ts installs it next to the runner job). Incident 2026-10-23: the Mac's runner went offline at 11:04 PT while the
// server kept answering /health, and nothing noticed for hours. launchd's KeepAlive restarts a runner that EXITS; this catches the rest
// (a runner that's alive but never reconnects, a job that was booted out and never came back):
//   1. the server answers (/health) but says this runner has been offline > 2 min (watchdog.staleSec in runner.json) -> restart it the
//      owner's way (client/service.ts healRunner: launchd kickstart -k, or bootstrap if the job was unloaded), at most 3 tries an hour,
//      2 min apart; never when the owner stopped it (kitebook stop runner leaves ~/.kitebook/stopped-runner)
//   2. down > 10 min and the restarts didn't bring it back -> one ntfy push to the owner's phone per outage (runner.json ntfy, if set up)
//   3. every run reports what it saw (op health_report), so op `status` and /start can say "Runner stopped 2h ago: self-restart failed"
// Logs: ~/Library/Logs/kitebook-watchdog.log (launchd's StandardOutPath); every restart and alert also goes to the audit log.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { apiCall } from "./api.ts";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export const WD = { STALE_MS: 2 * 60_000, ALERT_MS: 10 * 60_000, MAX_TRIES: 3, WINDOW_MS: 3600_000, GAP_MS: 2 * 60_000 };
export type WState = { tries: number[]; down_since: number | null; alerted_for: number | null; last_try: number | null; last_result: string | null; name?: string | null };
export type Obs = { now: number; server_ok: boolean; online: boolean; last_seen: number | null; stopped_by_owner: boolean };
export type Act = "restart" | "alert";
export const fresh = (): WState => ({ tries: [], down_since: null, alerted_for: null, last_try: null, last_result: null });

// Pure: what to do this minute, and the state to keep. Backoff = at most MAX_TRIES restarts per WINDOW_MS, GAP_MS apart (a restart
// needs time to reconnect before it counts as failed).
export function decide(st0: WState, o: Obs, k = WD): { acts: Act[]; state: WState; why: string; phase: string } {
  const st: WState = { ...st0, tries: st0.tries.filter(t => o.now - t < k.WINDOW_MS) };
  if (!o.server_ok) return { acts: [], state: st, why: "the server isn't answering, so it can't tell whether the runner is connected (not the runner's problem)", phase: "server_down" };
  if (o.stopped_by_owner) return { acts: [], state: { ...st, down_since: null, alerted_for: null }, why: "the owner stopped the runner (kitebook stop): leaving it stopped", phase: "stopped_by_owner" };
  if (o.online) { const back = st.down_since != null;
    return { acts: [], state: { ...st, down_since: null, alerted_for: null, ...(back && st.last_try ? { last_result: "ok" } : {}) }, why: back ? "the runner is back" : "the runner is connected", phase: "ok" }; }
  const since = st.down_since ?? o.last_seen ?? o.now, down = o.now - since, s2: WState = { ...st, down_since: since };
  if (down < k.STALE_MS) return { acts: [], state: s2, why: `offline for ${Math.round(down / 1000)}s: waiting (it may be reconnecting)`, phase: "watching" };
  const acts: Act[] = [];
  let phase = "backoff", why: string;
  if (st.tries.length < k.MAX_TRIES && (st.last_try == null || o.now - st.last_try >= k.GAP_MS)) { acts.push("restart"); phase = "restarting"; why = `offline for ${Math.round(down / 60_000)} min: restarting it (try ${st.tries.length + 1} of ${k.MAX_TRIES} this hour)`; }
  else if (st.tries.length >= k.MAX_TRIES) { phase = "gave_up"; why = `still offline after ${st.tries.length} restarts this hour: waiting for the owner (kitebook restart runner; kitebook logs runner)`; }
  else why = `restarted ${Math.round((o.now - (st.last_try ?? o.now)) / 1000)}s ago: giving it time to reconnect`;
  // the owner hears only when the automatic restarts didn't work: 10+ min down after at least one try (or every try used up)
  if (down >= k.ALERT_MS && (st.tries.length > 0 || phase === "gave_up") && !acts.includes("restart") && s2.alerted_for !== since) { acts.push("alert"); s2.alerted_for = since; }
  return { acts, state: s2, why, phase };
}

const KH = () => join(process.env.HOME || homedir(), ".kitebook"); // HOME read each time (tests point it elsewhere)
const STATE = () => join(KH(), "watchdog.json");
export const stoppedFlag = () => join(KH(), "stopped-runner"); // kitebook stop runner (client/service.ts)
const load = (): WState => { try { return { ...fresh(), ...JSON.parse(readFileSync(STATE(), "utf8")) }; } catch { return fresh(); } };
const save = (s: WState) => { try { mkdirSync(KH(), { recursive: true }); writeFileSync(STATE(), JSON.stringify(s)); } catch {} };
const log = (...a: any[]) => console.log(new Date().toISOString(), "watchdog:", ...a);

// the owner's phone (the same ntfy topic approvals use): once per outage
export async function alertPhone(cfg: any, text: string, f: typeof fetch = fetch): Promise<string> {
  const n = cfg?.ntfy; if (!n?.topic) return "no phone set up (ntfy.topic in runner.json)";
  try { const r = await f((n.server ?? "https://ntfy.sh").replace(/\/$/, ""), { method: "POST", headers: { "content-type": "application/json", ...(n.token ? { authorization: `Bearer ${n.token}` } : {}) },
      body: JSON.stringify({ topic: n.topic, title: "Kitebook: your Mac's runner is down", message: text.slice(0, 1500), priority: 4, tags: ["warning"], ...(cfg.url ? { click: `${cfg.url}/start` } : {}) }), signal: AbortSignal.timeout(10_000) });
    return r.ok ? "sent" : `ntfy answered ${r.status}`; } catch (e: any) { return `couldn't reach ntfy: ${e?.message ?? e}`; }
}

// One check (launchd runs it every minute). heal: the restart (client/service.ts healRunner); injectable for tests.
export async function once(cfgPath: string, o: { heal?: (cfg: any) => Promise<{ ok: boolean; how: string }>; f?: typeof fetch } = {}): Promise<{ phase: string; acts: Act[]; why: string }> {
  const f = o.f ?? fetch, cfg = JSON.parse(readFileSync(cfgPath, "utf8")), url = String(cfg.url ?? "").replace(/\/+$/, "");
  const k = { ...WD, ...(Number(cfg.watchdog?.staleSec) >= 0 && cfg.watchdog?.staleSec != null ? { STALE_MS: Number(cfg.watchdog.staleSec) * 1000 } : {}), ...(cfg.watchdog?.gapSec != null ? { GAP_MS: Number(cfg.watchdog.gapSec) * 1000 } : {}) };
  if (cfg.watchdog?.off === true) return { phase: "off", acts: [], why: "watchdog.off in runner.json" };
  const call = (op: string, a: any = {}) => apiCall({ ...cfg, url }, op, a, { timeoutMs: 15_000, fetcher: f });
  let st = load(), server_ok = false, online = false, last_seen: number | null = null;
  try { server_ok = (await f(`${url}/health`, { signal: AbortSignal.timeout(10_000) })).ok; } catch {}
  if (server_ok) try {
    if (!st.name) st.name = (await call("whoami")).name ?? null; // this runner's peer name (once)
    const me = ((await call("peers")).peers ?? []).find((p: any) => p.name === st.name);
    online = !!me?.online; last_seen = me?.last_seen ? Date.parse(me.last_seen) || null : null;
  } catch (e: any) { log(`couldn't read the runner's state from ${url}: ${e?.message ?? e}`); server_ok = false; }
  const d = decide(st, { now: Date.now(), server_ok, online, last_seen, stopped_by_owner: existsSync(stoppedFlag()) }, k); st = d.state;
  const audit = async (e: any) => { try { (await import("./guard.ts")).auditAppend({ type: "watchdog", by: "watchdog", ...e }); } catch {} };
  if (d.acts.includes("restart")) {
    const heal = o.heal ?? (async (c: any) => (await import("./service.ts")).healRunner(c));
    const r = await heal(cfg).catch((e: any) => ({ ok: false, how: `restart failed: ${e?.message ?? e}` }));
    st.tries = [...st.tries, Date.now()]; st.last_try = Date.now(); st.last_result = r.ok ? `restarted (${r.how}); waiting for it to reconnect` : r.how;
    log(d.why, "->", st.last_result); await audit({ action: "restart_runner", why: d.why, ok: r.ok, result: r.how, try: st.tries.length });
  } else if (d.phase !== "ok" || st.down_since != null) log(d.why);
  if (d.acts.includes("alert")) {
    const mins = Math.round((Date.now() - (st.down_since ?? Date.now())) / 60_000);
    const text = `${st.name ?? "Your Mac's runner"} has been offline for ${mins} min and ${st.tries.length ? `${st.tries.length} automatic restart${st.tries.length === 1 ? "" : "s"} didn't bring it back` : "couldn't be restarted automatically"}. Tasks wait until it's back. On the Mac run: kitebook restart runner (then kitebook logs runner).`;
    const how = await alertPhone(cfg, text, f); log("alert:", how); await audit({ action: "alert_owner", result: how, down_min: mins });
  }
  save(st);
  // what status shows (best effort: a server that's down can't hear it anyway)
  if (server_ok) { let last_exit: any; try { last_exit = JSON.parse(readFileSync(join(KH(), "runner-exit.json"), "utf8")); } catch {}
    await call("health_report", { watchdog: { state: d.phase, tries: st.tries.length, last_try: st.last_try, last_result: st.last_result, alerted: st.alerted_for != null ? st.down_since : null, stopped_by_owner: d.phase === "stopped_by_owner" }, ...(last_exit ? { last_exit } : {}) }).catch((e: any) => log("health_report:", e?.message ?? e)); }
  return { phase: d.phase, acts: d.acts, why: d.why };
}

if (import.meta.main) {
  const cfgPath = process.argv[2] ?? join(homedir(), ".kitebook", "runner.json");
  // no top-level await: healRunner (client/service.ts) imports this file, and a dynamic import of the entry module waits for its
  // evaluation, which a top-level await on once() never finishes (a deadlock: the watchdog hung without restarting anything)
  once(cfgPath).then(r => { if (process.argv.includes("--print")) console.log(JSON.stringify(r)); process.exit(0); },
    (e: any) => { log("error:", e?.message ?? e); process.exit(0); }); // exit 0 always: launchd runs it again in a minute either way
}
