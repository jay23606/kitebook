import { test, expect } from "bun:test";

test("kitebook help shows op metadata and suggests names for an unknown op", () => {
  const run = (op: string) => Bun.spawnSync([process.execPath, "run", "client/cli.ts", "help", op], { cwd: import.meta.dir + "/..", env: { ...process.env, KITEBOOK_CACHE: "" } });
  const good = run("task_create"), output = good.stdout.toString();
  expect(good.exitCode).toBe(0);
  expect(output).toContain("Hand a task to another peer");
  expect(output).toContain("target: string (required)");
  const bad = run("task_creat");
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("closest: task_create");
  for (const op of ["constructor", "__proto__"]) {
    const inherited = run(op);
    expect(inherited.exitCode).toBe(1);
    expect(inherited.stderr.toString()).toContain(`unknown op ${op}; closest:`);
  }
  for (const flag of ["--help", "-h"]) {
    const help = Bun.spawnSync([process.execPath, "run", "client/cli.ts", flag, "task_create"], { cwd: import.meta.dir + "/..", env: { ...process.env, KITEBOOK_CACHE: "" } });
    expect(help.exitCode).toBe(0);
    expect(help.stdout.toString()).toContain("kitebook");
    expect(help.stderr.toString()).not.toContain("set KITEBOOK_TOKEN");
  }
});
