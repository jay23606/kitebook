// Runner health (src/health.ts: status verdict, preflight) and the watchdog (client/watchdog.ts: restart decision, backoff, alert).
import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runnerVerdict, overall, preflight } from "../src/health.ts";
import { decide, fresh, WD, alertPhone, once } from "./watchdog.ts";

const NOW = Date.parse("2026-10-23T20:00:00Z"), at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

test("verdict: online is Working", () => {
  const r = runnerVerdict({ name: "mac", online: true, last_seen: at(0), running: 1, queued: 2 }, NOW);
  expect(r.state).toBe("online"); expect(r.line).toContain("1 running, 2 queued");
  expect(overall([r])).toEqual({ ok: true, verdict: "Working", next: null });
});
test("verdict: a dropped socket under 2 min is reconnecting, not an outage", () => {
  const r = runnerVerdict({ name: "mac", online: false, last_seen: at(1) }, NOW);
  expect(r.state).toBe("starting"); expect(overall([r]).ok).toBe(false); expect(overall([r]).verdict).toBe("Reconnecting");
});
test("verdict: runner stopped 2h ago, no watchdog: restart it on the Mac", () => {
  const r = runnerVerdict({ name: "mac", online: false, last_seen: at(120), queued: 3, last_exit: { reason: "crashed: boom" } }, NOW), v = overall([r]);
  expect(r.state).toBe("stopped"); expect(v.verdict).toBe("Runner stopped 2h ago"); expect(v.next).toContain("kitebook restart runner");
  expect(r.line).toContain("crashed: boom"); expect(r.line).toContain("3 queued"); expect(r.alert).toBe(true);
});
test("verdict: watchdog fresh and still trying: it's being restarted; gave up: owner's turn", () => {
  const trying = runnerVerdict({ name: "mac", online: false, last_seen: at(5), watchdog: { at: at(0.5), state: "restarting", tries: 1 } }, NOW);
  expect(trying.state).toBe("stopped"); expect(trying.healing).toContain("try 1 of 3"); expect(trying.next).toContain("Nothing yet"); expect(trying.alert).toBe(false);
  const gave = runnerVerdict({ name: "mac", online: false, last_seen: at(40), watchdog: { at: at(0.5), state: "gave_up", tries: 3, last_result: "restart failed: x" } }, NOW);
  expect(gave.healing).toContain("self-restart failed 3 times"); expect(gave.next).toContain("kitebook restart runner"); expect(gave.alert).toBe(true);
});
test("verdict: runner and watchdog both silent = Mac unreachable", () => {
  const r = runnerVerdict({ name: "mac", online: false, last_seen: at(180), watchdog: { at: at(179), state: "ok" } }, NOW), v = overall([r]);
  expect(r.state).toBe("unreachable"); expect(v.verdict).toBe("Mac unreachable, last seen 3h ago"); expect(v.next).toContain("Wake the Mac");
});
test("verdict: owner stopped it; never connected; no runners; one of two down", () => {
  expect(runnerVerdict({ name: "mac", online: false, last_seen: at(30), watchdog: { at: at(0.2), stopped_by_owner: true } }, NOW).next).toContain("kitebook start runner");
  expect(runnerVerdict({ name: "mac", online: false, last_seen: null, never_connected: true }, NOW).state).toBe("never_connected");
  expect(overall([]).verdict).toBe("No Mac connected");
  const two = overall([runnerVerdict({ name: "a", online: true, last_seen: at(0) }, NOW), runnerVerdict({ name: "b", online: false, last_seen: at(20) }, NOW)]);
  expect(two.verdict).toBe("Runner stopped 20m ago (b); 1 of 2 working");
});

const AD = { advertised: true, agents: ["pi", "codex"], agents_detail: [{ id: "pi", installed: true, tasks: true }, { id: "codex", installed: false, tasks: false }, { id: "claude", installed: true, tasks: false, issue: "not signed in" }],
  models: { pi: ["anthropic/claude-sonnet-4-5"] }, projects: { relay: { agent: "pi" } } };
test("preflight: all there, online -> nothing to say", () => {
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "pi", model: "claude-sonnet-4-5", project: "relay", ...AD })).toEqual({ problems: [], notes: [] });
});
test("preflight: missing agent, agent that can't run, model, project, checkout", () => {
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "codex", project: "relay", ...AD }).problems).toEqual(["codex isn't installed on mac"]);
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "codex", ...AD, agents_detail: [{ id: "codex", bin: "codex", installed: false }] }).problems[0]).toBe("codex isn't installed on mac (its program codex isn't on the runner's PATH: install it, or fix the agents entry in runner.json)");
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "claude", ...AD }).problems[0]).toBe("claude on mac can't run tasks: not signed in");
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "gemini", ...AD, agents_detail: [] }).problems[0]).toContain("gemini isn't set up on mac");
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "pi", model: "gpt-9", ...AD }).problems).toEqual(["model gpt-9 isn't available for pi on mac"]);
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "pi", project: "nope", ...AD }).problems).toEqual(["project nope isn't on mac"]);
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "pi", project: "relay", ...AD, code: { relay: { missing: true, error: "the checkout is gone from /x" } } }).problems).toEqual(["relay on mac: the checkout is gone from /x"]);
});
test("preflight: notes only (still queues): offline for how long, remote unreachable, agent not answering, no advert", () => {
  const off = preflight({ runner: "mac", online: false, last_seen: at(130), now: NOW, agent: "pi", project: "relay", ...AD, code: { relay: { fetch_error: { error: "Could not resolve host: github.com" } } },
    agents_detail: [{ id: "pi", installed: true, tasks: true, responds: false, responds_why: "pi --version hung for 15s" }] });
  expect(off.problems).toEqual([]); expect(off.notes[0]).toContain("offline for 2h 10m"); expect(off.notes.join(" ")).toContain("git fetch of relay failed on mac");
  expect(off.notes.join(" ")).toContain("pi didn't answer on mac at its last check (pi --version hung for 15s)");
  expect(preflight({ runner: "mac", online: true, last_seen: at(0), now: NOW, agent: "pi", advertised: false }).notes[0]).toContain("hasn't said what it has");
});

const obs = (o: Partial<{ now: number; server_ok: boolean; online: boolean; last_seen: number | null; stopped_by_owner: boolean }>) => ({ now: NOW, server_ok: true, online: false, last_seen: NOW - 5 * 60_000, stopped_by_owner: false, ...o });
test("watchdog: no restart while the server is down, the owner stopped it, or under 2 min", () => {
  expect(decide(fresh(), obs({ server_ok: false })).acts).toEqual([]);
  expect(decide(fresh(), obs({ stopped_by_owner: true })).phase).toBe("stopped_by_owner");
  expect(decide(fresh(), obs({ last_seen: NOW - 60_000 })).acts).toEqual([]);
  expect(decide(fresh(), obs({ online: true })).phase).toBe("ok");
});
test("watchdog: stale -> restart; backoff 2 min apart, at most 3 an hour; alert once after 10 min", () => {
  let s = fresh(), t = NOW; const tries: number[] = [];
  for (let m = 0; m < 60; m++, t += 60_000) {
    const d = decide(s, obs({ now: t, last_seen: NOW - 3 * 60_000 })); s = d.state;
    if (d.acts.includes("restart")) { tries.push(m); s.tries = [...s.tries, t]; s.last_try = t; }
  }
  expect(tries).toEqual([0, 2, 4]); // 3 tries, GAP apart, then none for the rest of the hour
  // the alert: exactly once per outage
  let s2 = fresh(), alerts = 0, firstAlert = -1; for (let m = 0; m < 30; m++) { const tt = NOW + m * 60_000, d = decide(s2, obs({ now: tt, last_seen: NOW - 3 * 60_000 })); s2 = d.state;
    if (d.acts.includes("restart")) { s2.tries = [...s2.tries, tt]; s2.last_try = tt; } if (d.acts.includes("alert")) { alerts++; if (firstAlert < 0) firstAlert = m; } }
  expect(alerts).toBe(1); expect(firstAlert).toBe(7); // 10 min down (3 before the first check), after the restarts failed
  // no restart was ever tried (e.g. it came back on its own each time): no alert, the owner isn't bothered
  expect(decide({ ...fresh(), down_since: NOW - 11 * 60_000, last_try: NOW - 60_000 }, obs({})).acts).not.toContain("alert");
  // an hour after the first try, tries free up again
  const later = decide({ ...fresh(), tries: [NOW - WD.WINDOW_MS - 1, NOW - 30 * 60_000, NOW - 20 * 60_000], last_try: NOW - 20 * 60_000, down_since: NOW - 70 * 60_000 }, obs({}));
  expect(later.acts).toContain("restart");
  // back online: reset, the last try counts as ok
  const back = decide({ ...fresh(), down_since: NOW - 600_000, last_try: NOW - 60_000, tries: [NOW - 60_000] }, obs({ online: true }));
  expect(back.state.down_since).toBeNull(); expect(back.state.last_result).toBe("ok");
});
test("watchdog: phone alert via ntfy, only when set up", async () => {
  expect(await alertPhone({}, "x")).toContain("no phone set up");
  let body: any = null; const f: any = async (_u: string, o: any) => { body = JSON.parse(o.body); return new Response("{}", { status: 200 }); };
  expect(await alertPhone({ ntfy: { topic: "t1" }, url: "https://k.example" }, "down", f)).toBe("sent");
  expect(body.topic).toBe("t1"); expect(body.click).toBe("https://k.example/start"); expect(body.priority).toBe(4);
});
test("watchdog once: server says offline -> heal called, state + report written; second run backs off", async () => {
  const h = mkdtempSync(join(tmpdir(), "wd-")); process.env.HOME = h; mkdirSync(join(h, ".kitebook"), { recursive: true });
  const cfg = join(h, "runner.json"); writeFileSync(cfg, JSON.stringify({ url: "http://k.test", token: "t", space: "main", watchdog: { staleSec: 0 } }));
  const seen = new Date(Date.now() - 1000).toISOString(), reports: any[] = [];
  const f: any = async (u: string, o: any) => { const op = u.split("/").pop(); const a = o?.body ? JSON.parse(o.body) : {};
    if (op === "health") return new Response("{}"); if (op === "whoami") return Response.json({ ok: true, result: { name: "mac" } });
    if (op === "peers") return Response.json({ ok: true, result: { peers: [{ name: "mac", online: false, last_seen: seen }] } });
    if (op === "health_report") { reports.push(a); return Response.json({ ok: true, result: { ok: true } }); } return Response.json({ ok: false, error: "?" }); };
  let heals = 0; const heal = async () => { heals++; return { ok: true, how: "launchd restart" }; };
  const r1 = await once(cfg, { f, heal }); expect(r1.acts).toContain("restart"); expect(heals).toBe(1);
  const st = JSON.parse(readFileSync(join(h, ".kitebook", "watchdog.json"), "utf8")); expect(st.tries.length).toBe(1); expect(st.name).toBe("mac");
  expect(reports[0].watchdog.state).toBe("restarting"); expect(reports[0].watchdog.tries).toBe(1);
  const r2 = await once(cfg, { f, heal }); expect(r2.acts).not.toContain("restart"); expect(heals).toBe(1); expect(r2.phase).toBe("backoff");
  writeFileSync(join(h, ".kitebook", "stopped-runner"), "x"); expect((await once(cfg, { f, heal })).phase).toBe("stopped_by_owner"); expect(existsSync(join(h, ".kitebook", "watchdog.json"))).toBe(true);
});
