// Chain step text and step normalization, shared by the server (src/space.ts renders each step's instructions from the chain)
// and the runner (client/sign.ts re-renders them to check a chain child against the chain its signed parent carried).
// Pure, no imports: it's bundled into the Worker and fetched by installed runners. Change it in one place only.
import "./brand.ts"; // first: RELAY_* env names from before the rename still work (client/brand.ts)
export const normStep = (s: any) => ({ kind: s.kind, instructions: String(s.instructions), agent: s.agent ?? null, model: s.model ?? null, verify: s.verify ?? null, title: s.title ?? null });
export function chainStepText(goal: string, steps: any[], i: number) {
  const s = steps[i], plan = steps.map((x, j) => `${j + 1}. ${x.kind}${x.agent ? ` (${x.agent}${x.model ? "/" + x.model : ""})` : ""}${j === i ? "  <- you" : ""}`).join("\n");
  return `${goal}\n\n---\nThis is step ${i + 1} of ${steps.length} of a chain run on one branch:\n${plan}\n\nYour step (${s.kind}): ${s.instructions}` +
    (s.kind === "review" ? `\n\nReview the changes already on this branch. Fix clear problems directly; list anything you are unsure about as open questions in your summary.` : s.kind === "test" ? `\n\nRun and extend the tests for the changes on this branch; fix what fails.` : ``);
}
