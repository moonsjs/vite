import { readFileSync } from "node:fs";
import type { BunPlugin } from "bun";
import { analyzeServerFile, injectServerFnMeta } from "./transform";

/**
 * Annotate a `*.server.ts` module with the transform-generated serverFn meta
 * (`__hash`, `__file`, `__line`, `__exportName`) — the same injection the
 * build performs. Used by `moons test` so tests can import server modules.
 */
export function transformServerModuleForTest(
  file: string,
  projectRoot = process.cwd(),
): string {
  const source = readFileSync(file, "utf8");
  const analysis = analyzeServerFile(source, file, projectRoot);
  return injectServerFnMeta(source, analysis, projectRoot);
}

/** Bun runtime plugin that applies the serverFn meta before tests load code. */
export function moonsTestPlugin(projectRoot = process.cwd()): BunPlugin {
  return {
    name: "moons-test-server-meta",
    setup(build) {
      build.onLoad({ filter: /\.server\.(ts|tsx)$/ }, (args) => ({
        contents: transformServerModuleForTest(args.path, projectRoot),
        loader: args.path.endsWith(".tsx") ? "tsx" : "ts",
      }));
    },
  };
}

export function registerMoonsTestPlugin(projectRoot = process.cwd()): void {
  Bun.plugin(moonsTestPlugin(projectRoot));
}
