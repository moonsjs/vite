import { expect, test } from "bun:test";
import { createLogger, redactPath } from "../src/server/logger";

test("L.3: JSON default — time, level, field apa adanya", () => {
  const lines: string[] = [];
  const log = createLogger({ write: (line) => lines.push(line) });
  log({ msg: "request", method: "GET", path: "/x", status: 200, durationMs: 3 });

  expect(lines.length).toBe(1);
  const parsed = JSON.parse(lines[0] as string) as Record<string, unknown>;
  expect(parsed["msg"]).toBe("request");
  expect(parsed["level"]).toBe("info");
  expect(parsed["status"]).toBe(200);
  expect(typeof parsed["time"]).toBe("string");
});

test("L.3: redaksi query-param (path) + tidak menyentuh path lain", () => {
  expect(redactPath("/auth?token=abc&ok=1", ["token"])).toBe(
    "/auth?token=%5Bredacted%5D&ok=1",
  );
  expect(redactPath("/plain", ["token"])).toBe("/plain");
  expect(redactPath("/auth?token=abc", [])).toBe("/auth?token=abc");

  const lines: string[] = [];
  const log = createLogger({ redact: ["key"], write: (line) => lines.push(line) });
  log({ msg: "request", path: "/x?key=RAHASIA", status: 200 });
  expect(lines[0]).toContain("key=%5Bredacted%5D");
  expect(lines[0]).not.toContain("RAHASIA");
});

test("L.3: mode teks ringkas (json: false)", () => {
  const lines: string[] = [];
  const log = createLogger({ json: false, write: (line) => lines.push(line) });
  log({ msg: "request", method: "POST", path: "/api/x", status: 429, durationMs: 12 });
  expect(lines[0]).toBe("[moons] INFO request /api/x 429 12ms");
});
