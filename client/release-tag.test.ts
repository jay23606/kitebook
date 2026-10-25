import { test, expect } from "bun:test";
import { releaseTag } from "../scripts/release-tag.ts";
test("calendar release tags use UTC dates and numbered revisions for same-day releases", () => {
  const today = new Date("2026-10-24T21:30:05-07:00");
  expect(releaseTag(today)).toBe("v2026.10.25");
  expect(releaseTag(today, ["v2026.10.25"])).toBe("v2026.10.25.2");
  expect(releaseTag(today, ["v2026.10.25", "v2026.10.25.2", "v2026.10.25.3"])).toBe("v2026.10.25.4");
  expect(releaseTag(new Date("2027-01-01T00:00:00Z"), ["v2026.12.31"])).toBe("v2027.01.01");
  expect(() => releaseTag(new Date("invalid"))).toThrow("invalid release date");
});
