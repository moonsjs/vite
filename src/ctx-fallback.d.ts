/**
 * Fallback global `Ctx` untuk kompilasi mandiri package ini.
 * Aplikasi memakai deklarasi hasil typegen (§13: `.moons/context.d.ts`).
 */
declare global {
  type Ctx = unknown;
}

export {};
