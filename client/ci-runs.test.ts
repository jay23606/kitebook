import { test, expect } from "bun:test";
import { mergeCiRuns } from "../src/ci-runs.ts";

test("a completed CI result survives every delivery order, including a late running report", () => {
  const q = { id: "job", state: "queued", at: 1 }, r = { ...q, state: "running", at: 2 }, p = { ...q, state: "passed", passed: 2, at: 3 };
  for (const order of [[q,r,p], [q,p,r], [r,q,p], [r,p,q], [p,q,r], [p,r,q]]) {
    let rows: any[] = []; for (const run of order) rows = mergeCiRuns(rows, "mac", [run]);
    expect(rows).toEqual([{ ...p, runner: "mac" }]);
    expect(mergeCiRuns(rows, "mac", [{ ...r, at: 999 }])).toEqual(rows);
  }
  for (const state of ["failed", "error", "cancelled", "skipped"]) {
    const done = mergeCiRuns([], "mac", [{ ...p, state }]); expect(mergeCiRuns(done, "mac", [r])).toEqual(done);
  }
});
test("queued reports cannot rewind running work; older running reports and other runners cannot replace it", () => {
  const rows = [{ id: "job", state: "running", at: 3, runner: "mac" }];
  for (const run of [{ id: "job", state: "queued", at: 4 }, { id: "job", state: "running", at: 2 }]) expect(mergeCiRuns(rows, "mac", [run])).toEqual(rows);
  expect(mergeCiRuns(rows, "another-mac", [{ id: "job", state: "passed", at: 5 }])).toEqual(rows);
  expect(mergeCiRuns(rows, "mac", [{ id: "job", state: "passed", at: 2 }])[0].state).toBe("passed"); // a clock correction cannot hide completion
});
test("CI status keeps the newest forty distinct runs", () => {
  const rows = mergeCiRuns([], "mac", Array.from({ length: 50 }, (_, at) => ({ id: String(at), state: "passed", at })));
  expect(rows.length).toBe(40); expect(rows[0].id).toBe("49"); expect(rows.at(-1).id).toBe("10");
});
