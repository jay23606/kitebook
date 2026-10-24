// Space side of the assistant brief (src/brief.ts says what it is): the brief / brief_propose ops for apps, and briefOwner, the owner's
// Settings actions (read, save, restore an older version = Undo, accept or dismiss a suggestion), reached only through the Dir with a
// signed-in session (src/start.ts). Every save runs the shared redactor (client/redact.ts): a secret is replaced and the saver warned.
import { RelayError, sha256, type Peer } from "../ops.ts";
import { BRIEF_PATH, BRIEF_MAX, BRIEF_DEFAULT, briefFor } from "../brief.ts";
import { OWNER, now, rid, redact } from "./util.ts";
import type { Space, Op } from "../space.ts";

const SECRET_WARN = "Something in it looked like a password, token or key, so it was replaced with [REDACTED]. Don't keep secrets in these instructions: every assistant reads them.";
const clean = (t: any) => { const s = String(t ?? "").replace(/\r\n/g, "\n"); if (s.length > BRIEF_MAX) throw new RelayError(413, `instructions: at most ${BRIEF_MAX} characters (this is ${s.length})`);
  const r = redact(s); return { text: r, warning: r !== s ? SECRET_WARN : undefined }; };
// No file yet = the default brief (every workspace has sensible instructions without a file appearing in it); a file, even an empty
// one, is the owner's text from then on.
async function raw(sp: Space) { const sha = sp.blobAt(BRIEF_PATH); return { sha, text: sha ? await sp.content(sha) : BRIEF_DEFAULT, default: !sha }; }
function lastChange(sp: Space) {
  const r = sp.sql.exec("select c.id, c.at, c.author from changes ch join commits c on c.seq=ch.seq where ch.path=? order by ch.seq desc limit 1", BRIEF_PATH).toArray()[0] as any;
  return r ? { commit: String(r.id).slice(0, 12), at: r.at, by: r.author } : null;
}
// What one app gets (its @sections only) and the etag clients compare (sha of exactly that text): describe, task_create, initialize.
export async function briefView(sp: Space, peer: Peer) {
  const r = await raw(sp), v = briefFor(r.text, peer.name, peer.kind);
  return { text: v.text, etag: v.text ? (await sha256(v.text)).slice(0, 12) : "none", chars: v.text.length, sections: v.sections, updated: lastChange(sp), ...(r.default ? { default: true } : {}) };
}
type Prop = { id: string; by: string; kind: string; at: string; text: string; note: string | null; base: string | null; warning?: string; state: string; decided_at?: string };
const props = (sp: Space) => sp.metaJ("brief_props", []) as Prop[];

export function briefOps(this: Space): Record<string, Op> {
  return {
    brief: async (peer, a) => { // read-only; no path grant needed: the brief is written for every app in the space
      this.need(peer, "read"); const v = await briefView(this, peer);
      if (a.if_none_match && a.if_none_match === v.etag) return { unchanged: true, etag: v.etag };
      const mine = props(this).filter(p => p.state === "pending" && p.by === peer.name).length;
      return { space: this.spaceId, ...v, ...(mine ? { pending_suggestions: mine } : {}),
        note: v.text ? "The owner's standing instructions for you: follow them. Suggest a change with brief_propose (the owner accepts it in Settings); you can't change them yourself."
          : "The owner hasn't written instructions for assistants in this workspace yet." };
    },
    brief_propose: async (peer, a) => { // a suggestion, never a change: it waits for the owner in Settings
      this.need(peer, "write");
      if (typeof a.text !== "string" || !a.text.trim()) throw new RelayError(400, "text: the full new instructions you suggest");
      const { text, warning } = clean(a.text), list = props(this), id = rid("bp");
      const replaced = list.filter(p => p.state === "pending" && p.by === peer.name).map(p => (p.state = "replaced", p.decided_at = now(), p.id)); // one pending per app
      if (list.filter(p => p.state === "pending").length >= 20) throw new RelayError(429, "20 suggestions are already waiting for the owner; try again after they decide");
      list.push({ id, by: peer.name, kind: peer.kind, at: now(), text, note: a.note == null ? null : redact(String(a.note)).slice(0, 500), base: this.blobAt(BRIEF_PATH), ...(warning ? { warning } : {}), state: "pending" });
      this.metaSet("brief_props", [...list.filter(p => p.state === "pending"), ...list.filter(p => p.state !== "pending").slice(-30)]);
      return { id, state: "pending", ...(replaced.length ? { replaced } : {}), ...(warning ? { warning } : {}),
        note: "Sent to the owner: they accept or dismiss it in Settings -> Instructions for your assistants. Nothing changes until they do; tell the user that." };
    },
  };
}

// The owner's Settings actions (Dir admin brief / brief_set). Saves commit as "owner"; commit() refuses the path to everyone else.
export async function briefOwner(sp: Space, a: any) {
  const act = String(a.action ?? "read");
  const save = async (text: string, message: string, ifMatch?: string | null) => {
    const r: any = await sp.commit(OWNER, [{ path: BRIEF_PATH, content: text, ...(ifMatch !== undefined ? { if_match: ifMatch ?? "none" } : {}) }], message);
    return { sha: r.shas[BRIEF_PATH] ?? sp.blobAt(BRIEF_PATH), commit: r.commit ? String(r.commit).slice(0, 12) : null, ...(r.unchanged ? { unchanged: true } : {}) };
  };
  if (act === "read") {
    const { sha, text, default: def } = await raw(sp), list = props(sp);
    const history = (sp.sql.exec("select c.id, c.at, c.author, ch.sha, b.size from changes ch join commits c on c.seq=ch.seq left join blobs b on b.sha=ch.sha where ch.path=? and ch.sha is not null order by ch.seq desc limit 10", BRIEF_PATH).toArray() as any[])
      .map(r => ({ commit: String(r.id).slice(0, 12), at: r.at, by: r.author, sha: r.sha, size: r.size }));
    return { space: sp.spaceId, path: BRIEF_PATH, text, sha, ...(def ? { default: true } : {}), max: BRIEF_MAX, history, suggestions: list.filter(p => p.state === "pending"), decided: list.filter(p => p.state !== "pending").slice(-5).reverse() };
  }
  if (act === "set") { const c = clean(a.text); return { ...await save(c.text, "assistant brief: edited in Settings", a.base === undefined ? undefined : a.base), ...(c.warning ? { warning: c.warning } : {}) }; }
  if (act === "restore") { // Undo = put back an earlier version from the file's own history
    const r = sp.sql.exec("select ch.sha from changes ch join commits c on c.seq=ch.seq where ch.path=? and c.id like ? and ch.sha is not null", BRIEF_PATH, String(a.commit ?? "") + "%").toArray() as any[];
    if (r.length !== 1 || !String(a.commit ?? "").trim()) throw new RelayError(404, "that version isn't in the history any more; reload Settings");
    return await save(await sp.content(r[0].sha), `assistant brief: restored the version from ${String(a.commit).slice(0, 12)}`, a.base === undefined ? undefined : a.base);
  }
  if (act === "accept" || act === "dismiss") {
    const list = props(sp), p = list.find(x => x.id === a.id && x.state === "pending"); if (!p) throw new RelayError(404, "that suggestion was already decided or replaced; reload Settings");
    const out = act === "accept" ? await save(p.text, `assistant brief: accepted ${p.by}'s suggestion`) : {};
    p.state = act === "accept" ? "accepted" : "dismissed"; p.decided_at = now(); sp.metaSet("brief_props", list);
    return { id: p.id, state: p.state, by: p.by, ...out };
  }
  throw new RelayError(400, "action: read | set | restore | accept | dismiss");
}
