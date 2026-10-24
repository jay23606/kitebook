// The assistant brief: owner-editable standing instructions for every connected assistant (Hark, Claude.ai, ChatGPT...), kept in the
// space as one versioned file so an assistant can't forget them between conversations. Pure helpers (no imports): the Space ops live in
// src/space/brief.ts, delivery in src/mcp.ts (initialize instructions), describe (src/space/peers.ts) and task_create (src/space.ts).
//   Where      context/assistant.md: versioned like any file (history = Undo), never pruned (retention and GC skip context/), kept out
//              of the KB index (it's delivered whole, not searched) and out of context packs (a project named "assistant" gets none).
//   Who edits  only the owner (Settings, signed-in session): commit() refuses every peer's write, move or delete of the path. Apps with
//              write access PROPOSE (brief_propose); the owner accepts or dismisses in Settings.
//   Default    a workspace with no file yet gets BRIEF_DEFAULT (no file is written, so a new workspace stays empty); the owner's first
//              save creates the file, and from then on the file (even empty) is the brief.
//   Per app    a heading "## @hark" (or "## @claude-ai @chatgpt", "## @assistants", "## @agents") starts a section only those apps get,
//              up to the next heading of the same or a higher level. Everything else goes to everyone.
export const BRIEF_PATH = "context/assistant.md";
export const BRIEF_MAX = 16_000; // chars stored (owner save and proposals)
export const BRIEF_INIT_MAX = 4_000, BRIEF_INIT_TOTAL = 8_000; // chars appended to MCP initialize instructions per space / in total
export const BRIEF_DEFAULT = `# Instructions for your assistants

Standing instructions from the owner of this workspace. Every connected assistant (Hark, Claude.ai, ChatGPT...) gets them when it connects, at the top of describe, and with each task it sends. The owner edits them in Settings -> Instructions for your assistants; an assistant can suggest a change with brief_propose (the owner accepts it there).

- Call describe before dispatching. Send code work with task_create to a Mac (runner); never paste code into shared/.
- Ask the owner before anything that deploys, publishes, sends a message to someone, spends money or can't be undone.
- When Kitebook refuses something, tell the owner in plain words what the error says they can do. Never ask for a recovery code, password or key.
- When the owner has to do something on their Mac, point them at kitebook commands or Settings, not raw system commands.
- Keep secrets out of tasks, files and these instructions.
- To update Kitebook, \`git pull\` in the Kitebook checkout is allowed and safe; the runner checks it and applies it.

A section only some apps see starts with a heading like "## @hark" or "## @claude-ai @chatgpt" ("@assistants" and "@agents" also work).
`;

// The text one app gets: the shared part plus its own @sections (heading kept), other apps' sections dropped.
export function briefFor(text: string, name: string, kind: string): { text: string; sections: string[] } {
  const out: string[] = [], sections = new Set<string>(); let skip = 0; // skip = level of the @heading being dropped (0 = keeping)
  const mine = (tags: string[]) => tags.some(t => t === name.toLowerCase() || (t === "assistants" && kind === "assistant") || (t === "agents" && kind === "coding_agent"));
  for (const l of String(text ?? "").split(/\r?\n/)) {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length; if (skip && lvl <= skip) skip = 0;
      const tags = [...h[2].matchAll(/@([a-z0-9][a-z0-9_-]{0,31})/gi)].map(m => m[1].toLowerCase());
      if (tags.length && /^(\s*@[a-z0-9][a-z0-9_-]{0,31}[\s,]*)+$/i.test(h[2])) { tags.forEach(t => sections.add(t)); if (!skip && !mine(tags)) { skip = lvl; continue; } }
    }
    if (!skip) out.push(l);
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), sections: [...sections].sort() };
}
// cap by characters on a line boundary, saying it was cut and where the rest is
export function capBrief(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max), i = cut.lastIndexOf("\n");
  return { text: (i > max / 2 ? cut.slice(0, i) : cut).trimEnd() + "\n[... cut here; call the brief tool for the rest]", truncated: true };
}
