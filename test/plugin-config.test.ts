import { expect, test } from "bun:test";
import moons from "../src/index";

type ConfigEnv = { isSsrBuild?: boolean };
type ConfigHook = (
  config: Record<string, unknown>,
  env: ConfigEnv,
) => Record<string, unknown> | null | Promise<Record<string, unknown> | null>;

function getConfigHook(): ConfigHook {
  const plugin = moons();
  return (plugin as unknown as { config: ConfigHook }).config;
}

test("config dev: @moonsjs/* di-inline ke SSR pipeline (fix dua instans React)", async () => {
  const hook = getConfigHook();
  const config = (await hook({}, { isSsrBuild: false })) as {
    ssr?: { noExternal?: unknown };
  };

  const noExternal = config.ssr?.noExternal;
  expect(Array.isArray(noExternal)).toBe(true);
  const patterns = noExternal as RegExp[];
  expect(patterns.some((pattern) => pattern.test("@moonsjs/react"))).toBe(true);
  expect(patterns.some((pattern) => pattern.test("@moonsjs/vite/server"))).toBe(true);
  expect(patterns.some((pattern) => pattern.test("@moonsjs/core"))).toBe(true);
});

test("config build SSR: noExternal true (tidak berubah)", async () => {
  const hook = getConfigHook();
  const config = (await hook({}, { isSsrBuild: true })) as { ssr?: { noExternal?: unknown } };
  expect(config.ssr?.noExternal).toBe(true);
});
