// Runner knowledge base sync: publish allowlisted local memory, keep the local KB read cache fresh, drain the offline outbox.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import * as KB from "./kb.ts";
import * as OB from "./outbox.ts";
import { ioStats, cfgNow, call, log, cfg, me } from "./runner-ctx.ts";

// ---- shared knowledge base: publish allowlisted local memory (read-only), mirror the KB to a local cache ----
export const kbCacheDir = () => cfg.kb?.cache === false ? null : KB.expand(cfg.kb?.cache ?? "~/.kitebook-kb/kb");
export let kbBusy = false, kbSigs = new Map<number, string>(), kbAgain = false, kbLastErr = "", kbState = new Map<string, any>(), kbLastOk: string | null = null;
// Idle cost: unchanged files aren't read (stat cache in KB.chunksOf), unchanged sources make no calls (kbSigs), changed ones diff
// against the persisted manifest (no kb_list; a full list only on first run / lost manifest / every kb.reconcileHours, default 6).
// The read cache is kept fresh by kb/ + context/ events (kbPoke); the periodic tick pulls only after our own publish changed
// something or every kb.pullEvery seconds (default 900) as a safety net, so an idle tick makes no KB calls at all.
export let kbManFile = ""; let kbMan: KB.Manifest | null = null, kbPulledAt = 0, kbPullDue = true;
export async function kbTick(pullOnly = false) {
  if (kbBusy) { kbAgain = true; return; } kbBusy = true;
  try {
    const live = (cfgNow() ?? cfg).kb; cfg.kb = live; // runner.json edits apply without a restart (re-parsed only when the file changed)
    if (!pullOnly && live?.sync?.length) { let errs = 0;
      kbMan ??= KB.loadManifest(kbManFile, cfg.url); const reconcile = Math.max(0, Number(live?.reconcileHours ?? 6)) * 3600_000;
      for (const [i, e] of (live?.sync ?? []).entries()) {
        const ch = KB.chunksOf(e).chunks, sig = KB.hashOf(JSON.stringify([e, ch.map(c => [c.key, c.hash])])), st = kbState.get(e.path) ?? {};
        kbState.set(e.path, Object.assign(st, { origin: e.origin ?? `${me.name}-memory`, scope: e.scope ?? "global", chunks: ch.length })); if (kbSigs.get(i) === sig) continue; // unchanged locally: no network
        try { const r = await KB.publish(call, e, `${me.name}-memory`, live?.ollama, kbMan, reconcile); kbSigs.set(i, sig); Object.assign(st, { synced_at: new Date().toISOString(), error: undefined });
          KB.saveManifest(kbManFile, kbMan); if (r.added || r.removed) kbPullDue = true;
          if (r.added || r.removed || r.rejected) log(`kb sync ${r.prefix}: ${r.added} upserted, ${r.removed} forgotten, ${r.rejected} refused (${r.chunks} chunks)`); }
        catch (err: any) { errs++; st.error = err.message; log("kb sync error", e.path, err.message); } // retried next tick (offline, conflict: the server wins)
      }
      // a reconcile is due even when nothing changed locally: forget kbSigs for sources whose manifest is stale, so the next tick lists
      for (const [i, e] of (live?.sync ?? []).entries()) { const m = kbMan.sources[KB.sourceKey(e, `${me.name}-memory`)]; if (m && Date.now() - m.listed_at >= reconcile) kbSigs.delete(i); }
      // doctor reads this (sources, chunk count, last sync); only current entries are kept
      const at = new Date().toISOString(), paths = new Set(live.sync.map((e: any) => e.path)); for (const k of kbState.keys()) if (!paths.has(k)) kbState.delete(k);
      if (!errs) kbLastOk = at; try { const f = KB.syncStateFile(me.name, cfg.space); mkdirSync(dirname(f), { recursive: true });
        writeFileSync(f, JSON.stringify({ checked_at: at, last_ok: kbLastOk, errors: errs, sources: [...kbState].map(([path, v]) => ({ path, ...v })) }, null, 1)); } catch {}
    }
    const dir = kbCacheDir(), pullEvery = Math.max(1, Number(live?.pullEvery ?? 900) || 900) * 1000;
    if (dir && (pullOnly || kbPullDue || Date.now() - kbPulledAt >= pullEvery)) try { kbPullDue = false; const r = await KB.pullCache(call, dir, join(homedir(), ".kitebook", `${me.name}.${cfg.space}.kb-cursor.json`)); kbPulledAt = Date.now(); if (r.wrote || r.removed) log(`kb cache ${dir}: ${r.wrote} updated, ${r.removed} removed (v${r.cursor})`); }
      catch (err: any) { kbPullDue = true; if (err.message !== kbLastErr) log("kb cache error", err.message); kbLastErr = err.message; } // once per distinct error (e.g. an older Kitebook)
  } finally { kbBusy = false; ioStats(); if (kbAgain) { kbAgain = false; setTimeout(() => kbTick(true), 200); } }
}
// Offline-first KB writes from local agents (client/outbox.ts): `kitebook kb add` notes queued while the server was down, and markdown
// dropped into ~/.kitebook-kb/kb-inbox/, are sent every kb tick and on reconnect, oldest first; the server wins a conflict (logged).
export let obBusy = false;
export async function outboxTick() {
  if (obBusy || cfg.kb?.outbox === false) return; obBusy = true;
  try { const o = await OB.drainOutbox(call, cfg.url, cfg.space, log); if (!o.offline) await OB.publishInbox(call, log); }
  catch (e: any) { log("kb outbox error", e.message); } finally { obBusy = false; }
}
let kbSoon: any = null; export const kbPoke = () => { clearTimeout(kbSoon); kbSoon = setTimeout(() => kbTick(true), 500); }; // a kb/ change event: refresh the cache
export function initKb() { kbManFile = KB.manifestFile(me.name, cfg.space); } // runner.ts calls this once `me` is known
