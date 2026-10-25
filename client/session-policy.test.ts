import { test, expect } from "bun:test";
import { sessionRuleError, sessionLevel, sessionDecision, sessionRuleWords, type SessionRule } from "./session-policy.ts";
const identity = { peer: "p_muse", epoch: "generation-one", connected: true };
const rule: SessionRule = { v: 1, ...{peer:identity.peer,epoch:identity.epoch}, projects: ["kitebook"], access: "fork", approval: "auto", keys: ["ed25519:" + "A".repeat(43)] };
const entry = (r = rule) => ({ tasks: "ask", projects: [], sessions: "off", session_rule: r });
test("session access is enabled by default and a saved rule is bound to the exact app connection", () => {
  expect(sessionLevel(undefined,identity)).toBe("write"); expect(sessionLevel({sessions:null},identity)).toBe("write"); expect(sessionLevel({until:1},identity)).toBe("write"); expect(sessionLevel(entry(),identity)).toBe("write");
  for (const changed of [{...identity,peer:"p_hark"},{...identity,epoch:"new"},{...identity,connected:false}]) expect(sessionLevel(entry(),changed)).toBe("off");
  expect(sessionLevel(entry())).toBe("off"); expect(sessionLevel({...entry(),until:1},identity)).toBe("off");
  // Older runners see sessions:off and cannot reinterpret a scoped permission as unrestricted read/write.
  expect(entry().sessions).toBe("off");
});
test("revocation prevents unbound legacy permissions from reviving on reconnect", () => {
  expect(sessionLevel({sessions:"write"},{...identity,epoch:""})).toBe("write");
  expect(sessionLevel({sessions:"write"},identity)).toBe("off");
});
test("saved project scope controls reads; out-of-scope execution needs a one-time approval", () => {
  expect(sessionDecision(entry(),identity,"kitebook","read").allowed).toBe(true);
  expect(sessionDecision(entry(),identity,"private","read").allowed).toBe(false);
  expect(sessionDecision(entry(),identity,"private","fork")).toMatchObject({allowed:true,automatic:false,ask:true});
  expect(sessionDecision(entry(),identity,null,"fork").automatic).toBe(false);
  expect(sessionDecision(entry(),identity,"kitebook","fork")).toMatchObject({allowed:true,automatic:true,ask:false});
});
test("copy-only and ask-each-time rules cannot silently allow original session use", () => {
  expect(sessionDecision(entry(),identity,"kitebook","continue")).toMatchObject({automatic:false,ask:true});
  expect(sessionDecision(entry({...rule,access:"idle"}),identity,"kitebook","continue").automatic).toBe(true);
  expect(sessionDecision(entry({...rule,approval:"ask"}),identity,"kitebook","fork")).toMatchObject({automatic:false,ask:true});
  expect(sessionDecision(entry({...rule,access:"read"}),identity,"kitebook","fork").allowed).toBe(false);
});
test("session rule validation refuses malformed scope, unknown capabilities and missing automatic signing keys", () => {
  expect(sessionRuleError(rule)).toBe(null);
  for (const bad of [{...rule,projects:[]},{...rule,projects:["*"]},{...rule,projects:["kitebook","kitebook"]},{...rule,approval:"never"},{...rule,access:"all"},{...rule,keys:[]},{...rule,peer:""},{...rule,extra:true}]) expect(sessionRuleError(bad)).not.toBe(null);
  expect(sessionRuleError({...rule,approval:"ask",keys:[]})).toBe(null);
  expect(sessionRuleWords(rule)).toContain("kitebook without repeated approvals");
});
