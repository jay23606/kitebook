// Owner-signed session consent. Project scope concerns session context, independently of task autorun permissions.
export type SessionRule = { v: 1; peer: string; epoch: string; projects: string[]; access: "read" | "fork" | "idle"; approval: "ask" | "auto"; keys: string[] };
export type SessionIdentity = { peer: string; epoch: string; connected: boolean };
export function sessionRuleError(r: any): string | null {
  if (!r || typeof r !== "object" || Array.isArray(r) || r.v !== 1 || Object.keys(r).some(k => !["v","peer","epoch","projects","access","approval","keys"].includes(k))) return "session rule: expected v1 consent";
  if (typeof r.peer !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.peer) || typeof r.epoch !== "string" || r.epoch.length > 100) return "session rule: connection identity required";
  if (!["read","fork","idle"].includes(r.access) || !["ask","auto"].includes(r.approval)) return "session rule: invalid access or approval mode";
  if (!Array.isArray(r.projects) || !r.projects.length || r.projects.length > 100 || r.projects.some((p: any) => typeof p !== "string" || !/^[\w.-]{1,64}$/.test(p)) || new Set(r.projects).size !== r.projects.length) return "session rule: choose one or more projects";
  if (!Array.isArray(r.keys) || r.keys.length > 4 || r.keys.some((k: any) => !/^ed25519:[A-Za-z0-9_-]{43}$/.test(k)) || r.approval === "auto" && r.access !== "read" && !r.keys.length) return "session rule: automatic work needs a signing key";
  return null;
}
export function sessionLevel(e: any, identity?: SessionIdentity, now = Date.now()): "off" | "read" | "write" {
  if (identity?.connected === false) return "off";
  if (e?.session_rule !== undefined) {
    const r = e.session_rule;
    if (sessionRuleError(r) || !identity || r.peer !== identity.peer || r.epoch !== identity.epoch || e.sessions !== "off" || e.until != null && !(Number(e.until) > now)) return "off";
    return r.access === "read" ? "read" : "write";
  }
  // Connected apps inherit the enabled default, independently of task-autorun expiry.
  if (e?.sessions == null) return "write";
  if (e.until != null && !(Number(e.until) > now)) return "off";
  // Existing explicit grants remain compatible until revoked. A reconnect never revives an old unbound grant.
  if (identity?.epoch) return "off";
  return e.sessions === "read" || e.sessions === "write" ? e.sessions : "off";
}
export function sessionDecision(e: any, identity: SessionIdentity | undefined, project: string | null, action: "read" | "fork" | "continue", now = Date.now()) {
  const level = sessionLevel(e, identity, now), r: SessionRule | undefined = e?.session_rule;
  if (level === "off" || action !== "read" && level !== "write") return { allowed: false, automatic: false, ask: false, why: "session access is off or read-only" };
  if (!r) return { allowed: true, automatic: false, ask: action === "continue", why: "existing session permission" };
  const scoped = !!project && r.projects.includes(project);
  if (action === "read") return { allowed: scoped, automatic: scoped, ask: false, why: scoped ? "saved session permission" : "session is outside the projects you allowed" };
  const automatic = scoped && r.approval === "auto" && (action !== "continue" || r.access === "idle");
  return { allowed: true, automatic, ask: !automatic, why: !scoped ? "session is outside the projects you allowed" : action === "continue" && r.access !== "idle" ? "using the original session needs approval" : r.approval === "ask" ? "you chose to approve session work each time" : "saved session permission" };
}
export function sessionRuleWords(r: SessionRule): string {
  return `can ${r.access === "read" ? "read" : r.access === "fork" ? "read and continue copies of" : "read, copy and continue idle originals of"} sessions in ${r.projects.join(", ")}${r.access === "read" ? "" : r.approval === "auto" ? " without repeated approvals" : "; starting work asks you"}`;
}
