// Runner state shared by runner.ts and the runner-*.ts modules: the config (cfg, cfgPath), this runner's identity (me), the server
// call, logging, shell helper and work counters. runner.ts sets cfg/me once at startup, before any module function runs; modules read
// them through ES live bindings, so nothing here holds a stale copy.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { readFileSync, writeFileSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import * as KB from "./kb.ts";
import { requestSignal } from "./retry.ts";

export let cfg: any;
export let me: any;
export let cfgPath = "runner.json";
export let H: Record<string, string> = {};
export const setCfgPath = (p: string) => { cfgPath = p; };
export const setCfg = (c: any) => { cfg = c; };
export const setMe = (m: any) => { me = m; };
export const setH = () => { H = { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }; };
// runner.ts registers what modules may call back into (advertise this runner's capabilities again)
export const on = { advertise: async (): Promise<void> => {} };

// Work counters (local reads, KB calls, mirror reads, code reports): under KITEBOOK_TEST they are written to
// ~/.kitebook/<name>.<space>.io.json after each kb tick / mirror scan, so smoke can prove an idle runner does no work.
export const io = { cfgParses: 0, mirrorScans: 0, mirrorReads: 0, mirrorSent: 0, codeReports: 0, codeSkipped: 0 };
export function ioStats() { if (!process.env.KITEBOOK_TEST) return; try { writeFileSync(join(homedir(), ".kitebook", `${me.name}.${cfg.space}.io.json`), JSON.stringify({ ...io, kbReads: KB.io.reads, kbCalls: KB.io.calls })); } catch {} }
// runner.json as it is on disk, re-read and re-parsed only when its size/mtime/inode changed (hot-reload polls it every 3 s, kb and
// advertise every minute). null = unreadable/invalid (callers keep what they have, as before). The parsed object is shared: read-only.
export function cfgNow(): any { try { const s = statSync(cfgPath), sig = `${s.size}:${s.mtimeMs}:${s.ino}`, me_ = cfgNow as any;
  if (me_.sig !== sig) { me_.val = JSON.parse(readFileSync(cfgPath, "utf8")); me_.sig = sig; io.cfgParses++; } return me_.val; } catch { return null; } }
export async function call(op: string, args: any = {}, signal?: AbortSignal) {
  const r = await fetch(`${cfg.url}/v1/${op}`, { method: "POST", headers: H, body: JSON.stringify({ space: cfg.space, ...args }), signal: requestSignal(signal) });
  const j: any = await r.json(); if (!r.ok || !j.ok) throw new Error(`${op}: answered HTTP ${r.status}: ${j.error ?? "request failed"}`); return j.result;
}
export const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function sh(cmd: string[], cwd: string, env?: Record<string, string>) {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: env ?? process.env as any });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
}
