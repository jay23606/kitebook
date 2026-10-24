// KB files the server sends land only inside the local folder (client/kb.ts localPath: the read cache and kb export). A backslash path
// passes the server's "/"-only ".." check, and a relay that misbehaves could send "../" or an absolute path; none of them may leave the folder.
import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync, existsSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import * as KB from "./kb.ts";

const T = mkdtempSync(join(tmpdir(), "kitebook-kbpaths-"));
const BAD = ["kb/a\\..\\..\\..\\evil.md", "kb/../evil.md", "kb/x/../../evil.md", "../evil.md", "/etc/evil.md", "kb//etc/evil.md", "C:\\evil.md", "C:evil.md", "kb/./x.md", "kb/", "", "kb/a\0b.md"];

test("localPath keeps plain paths inside the folder and refuses the rest", () => {
  const d = join(T, "lp");
  expect(KB.localPath(d, "kb/demo/ops.md")).toBe(resolve(d, "demo/ops.md"));
  expect(KB.localPath(d, "context/main.md")).toBe(resolve(d, "context/main.md"));
  expect(KB.localPath(d, "kb/a//b.md")).toBe(resolve(d, "a/b.md"));
  expect(KB.localPath(d, "kb/..notes.md")).toBe(resolve(d, "..notes.md")); // a name that only starts with two dots is fine
  for (const p of BAD) expect(KB.localPath(d, p)).toBeNull();
});

// a fake relay: kb_list/glob name every path above, read answers each with its own name as the content
const fake = (paths: string[]) => async (op: string, a: any = {}) => {
  if (op === "kb_list") return { entries: paths.map(path => ({ path })), cursor: 7, more: false };
  if (op === "glob") return a.pattern === "kb/**" ? { files: paths } : { files: [] };
  if (op === "read") return { content: `from ${a.path}` };
  throw new Error("unexpected " + op);
};
const PATHS = ["kb/demo/ops.md", ...BAD];

test("pullCache writes only the plain path", async () => {
  const d = join(T, "cache", "kb"), r = await KB.pullCache(fake(PATHS), d, join(T, "cache", "cursor.json"));
  expect(r.wrote).toBe(1); expect(readFileSync(join(d, "demo", "ops.md"), "utf8")).toBe("from kb/demo/ops.md");
  expect(readdirSync(join(T, "cache")).sort()).toEqual(["cursor.json", "kb"]); expect(existsSync(join(T, "evil.md"))).toBe(false);
});

test("kb export writes only the plain path", async () => {
  const d = join(T, "exp", "out"), r = await KB.exportTo(fake(PATHS), d);
  expect(r.files).toBe(1); expect(readdirSync(join(T, "exp"))).toEqual(["out"]); expect(readdirSync(d)).toEqual(["demo"]);
  expect(existsSync(join(T, "evil.md"))).toBe(false);
});
