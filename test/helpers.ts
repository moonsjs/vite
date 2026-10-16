import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ProjectFixture {
  root: string;
  routesDir: string;
}

/** Buat project fixture dengan file di bawah src/routes. */
export function makeProject(files: ReadonlyArray<string>): ProjectFixture {
  const root = mkdtempSync(join(tmpdir(), "moons-project-"));
  const routesDir = join(root, "src/routes");
  mkdirSync(routesDir, { recursive: true });
  for (const file of files) {
    const full = join(routesDir, file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "// fixture\n");
  }
  return { root, routesDir };
}
