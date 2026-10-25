import { test, expect } from "bun:test";
import { releaseTag } from "../scripts/release-tag.ts";
test("calendar release tags use UTC, sort chronologically and distinguish same-day releases", () => {
  expect(releaseTag(new Date("2026-10-24T21:30:05-07:00"))).toBe("v2026.10.25-043005");
  const tags = ["2026-12-31T23:59:59Z", "2027-01-01T00:00:00Z", "2027-01-01T00:00:01Z"].map(x => releaseTag(new Date(x)));
  expect([...tags].sort()).toEqual(tags); expect(new Set(tags).size).toBe(3);
  expect(() => releaseTag(new Date("invalid"))).toThrow("invalid release date");
});
