// Space ops: the live knowledge base (src/kb.ts). Part of the impl table (src/space.ts); `this` is the Space.
import * as KB from "../kb.ts";
import { guard } from "./util.ts";
import type { Space, Op } from "../space.ts";

export function kbOps(this: Space): Record<string, Op> {
  return {
    // ---------- live knowledge base (src/kb.ts): entries are files under kb/, search is a derived index ----------
    kb_add: async (peer, a) => KB.add(this, peer, a, guard),
    kb_search: async (peer, a) => KB.search(this, peer, a),
    kb_get: async (peer, a) => KB.get(this, peer, a),
    kb_list: async (peer, a) => KB.list(this, peer, a),
    kb_forget: async (peer, a) => KB.forget(this, peer, a),
  };
}
