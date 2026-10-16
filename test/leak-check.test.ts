import { expect, test } from "bun:test";
import { findLeak } from "../src/leak-check";

test("findLeak mendeteksi canary di chunk code dan asset biner", () => {
  const canary = "MOONS_LEAK_CANARY_7f3a91b2";

  expect(
    findLeak(
      [
        { type: "chunk", fileName: "assets/index-abc.js", code: "console.log(1);" },
        { type: "chunk", fileName: "assets/leak.js", code: `const x = "${canary}";` },
      ],
      canary,
    ),
  ).toEqual({ fileName: "assets/leak.js" });

  expect(
    findLeak(
      [{ type: "asset", fileName: "assets/blob.bin", source: new TextEncoder().encode(canary) }],
      canary,
    ),
  ).toEqual({ fileName: "assets/blob.bin" });

  expect(
    findLeak([{ type: "asset", fileName: "styles.css", source: "body { color: red }" }], canary),
  ).toBeNull();
});
