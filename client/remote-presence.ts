// The master password typed on another device (a phone), relayed here by the server (src/remote-pw.ts; docs/security.md): checked with this
// Mac's own password key (unlock: Argon2id + its waits), signs exactly that one approval, forgotten. Only pairing codes and presence
// confirmations; 5 wrong per code / 5 in 15 min lock it for 15 min (audited); runner.json "remotePassword": false turns it off here.
import "./brand.ts";

export const REMOTE_ACTION = /^(device_grant:[A-Z]{4}-[A-Z]{4}|confirm:[A-Z]{6})$/;
export const MAX_WRONG = 5, LOCK_MS = 15 * 60_000;
export class RemoteLimiter {
  byCode = new Map<string, number>(); recent: number[] = []; until = 0;
  constructor(private now = () => Date.now()) {}
  check(action: string): string | null {
    if (this.until > this.now()) return `remote password approval is locked for ${Math.ceil((this.until - this.now()) / 60_000)} min after ${MAX_WRONG} wrong passwords; approve on your Mac (kitebook approve) meanwhile`;
    if ((this.byCode.get(action) ?? 0) >= MAX_WRONG) return `${MAX_WRONG} wrong passwords for this code: it can't be approved with a password from another device any more; approve it on your Mac`;
    return null;
  }
  wrong(action: string): boolean {
    const t = this.now(); this.byCode.set(action, (this.byCode.get(action) ?? 0) + 1);
    this.recent = [...this.recent.filter(x => t - x < LOCK_MS), t];
    if (this.recent.length >= MAX_WRONG) { this.until = t + LOCK_MS; this.recent = []; return true; }
    return false;
  }
  right(action: string) { this.byCode.delete(action); }
}

export type RemoteAnswer = { ok: true; presence: string } | { ok: false; error: string; wrong?: boolean; locked?: boolean };
export async function remoteAnswer(q: any, o: { enabled: boolean; hasPassword: boolean; limiter: RemoteLimiter;
  assert: (action: string, sign: (msg: string) => Promise<string | null>) => Promise<string | null>; unlockSign: (pw: string, msg: string) => Promise<string>;
  audit: (e: any) => void }): Promise<RemoteAnswer> {
  const action = String(q?.action ?? ""), pw = typeof q?.password === "string" ? q.password : "";
  if (!o.enabled) return { ok: false, error: "this Mac doesn't take the master password from other devices (runner.json \"remotePassword\": false)" };
  if (!REMOTE_ACTION.test(action)) { o.audit({ type: "remote_password_refused", action: action.slice(0, 60), why: "not an approval this takes" }); return { ok: false, error: "refused: only a pairing code or a presence confirmation can be approved with the password from another device" }; }
  if (!o.hasPassword) return { ok: false, error: "this Mac has no master password yet (kitebook password set)" };
  if (!pw || pw.length > 1024) return { ok: false, error: "type your Kitebook master password", wrong: true };
  const lim = o.limiter.check(action); if (lim) return { ok: false, error: lim, locked: true };
  let why = "";
  try { const p = await o.assert(action, m => o.unlockSign(pw, m)); if (p) { o.limiter.right(action); o.audit({ type: "remote_password", action, ok: true }); return { ok: true, presence: p }; } why = "not confirmed"; }
  catch (e: any) { why = String(e?.message ?? e).slice(0, 200); }
  if (/^too many wrong/.test(why)) { o.audit({ type: "remote_password", action, ok: false, why: "waiting" }); return { ok: false, error: why, locked: true }; }
  const locked = o.limiter.wrong(action);
  o.audit({ type: locked ? "remote_password_locked" : "remote_password", action, ok: false, why: /wrong master password/.test(why) ? "wrong password" : why.slice(0, 80) });
  return { ok: false, error: locked ? `wrong master password; ${MAX_WRONG} wrong in a row, so approving with the password from other devices is locked for 15 min (approve on your Mac meanwhile)` : /wrong master password/.test(why) ? "wrong master password" : why, wrong: true, ...(locked ? { locked: true } : {}) };
}
