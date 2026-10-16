import { renameSync, writeFileSync } from "node:fs";
import type { PrerenderStorage } from "@moonsjs/core";
import { scanPayloadForSecrets } from "../payload-scan";

/**
 * ISR / revalidate on-demand (PRD Addendum E.1): file prerender yang kedaluwarsa
 * disajikan apa adanya (stale-while-revalidate) sambil diregenerasi via handler
 * SSR in-process. Tulis atomik + guard kebocoran fail-closed.
 */
export function shouldRevalidate(input: {
  mtimeMs: number;
  revalidateSeconds: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return now - input.mtimeMs >= input.revalidateSeconds * 1000;
}

export interface RevalidateOptions {
  /** Path URL ternormalisasi (mis. "/blog/hello"). */
  pathname: string;
  /** File HTML yang akan ditimpa (default file storage). */
  file?: string;
  /**
   * Storage alternatif (Addendum I). Bila diisi, `file` diabaikan dan hasil
   * regenerasi ditulis lewat `storage.write(pathname, body)`.
   */
  storage?: PrerenderStorage;
  handler: (request: Request) => Promise<Response>;
  canary?: string;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

const inflight = new Map<string, Promise<void>>();

/** Regenerasi ter-dedupe per path (panggilan paralel berbagi promise). */
export function revalidatePrerendered(options: RevalidateOptions): Promise<void> {
  const existing = inflight.get(options.pathname);
  if (existing !== undefined) {
    return existing;
  }
  const task = runRevalidate(options).finally(() => {
    inflight.delete(options.pathname);
  });
  inflight.set(options.pathname, task);
  return task;
}

async function runRevalidate(options: RevalidateOptions): Promise<void> {
  const log = options.log ?? ((message: string) => console.log(message));
  try {
    const response = await options.handler(
      new Request(`http://localhost${options.pathname}`, {
        method: "GET",
        headers: { "x-moons-prerender": "1" },
      }),
    );
    if (response.status !== 200) {
      log(`[moons] isr: lewati ${options.pathname} (status ${response.status})`);
      return;
    }
    const html = await response.text();
    const findings = scanPayloadForSecrets(html, {
      ...(options.canary === undefined ? {} : { canary: options.canary }),
      env: options.env ?? process.env,
    });
    if (findings.length > 0) {
      const labels = findings
        .map((finding) => (finding.kind === "canary" ? "canary" : `env(${finding.label})`))
        .join(", ");
      // Fail-closed: jangan menimpa file statis dengan konten bocor.
      log(`[moons] isr: TIDAK menulis ${options.pathname} — memuat ${labels}`);
      return;
    }
    if (options.storage !== undefined) {
      await options.storage.write(options.pathname, new TextEncoder().encode(html));
      return;
    }
    if (options.file === undefined) {
      log(`[moons] isr: lewati ${options.pathname} — tanpa file/storage tujuan`);
      return;
    }
    const tmp = `${options.file}.tmp-${process.pid}`;
    writeFileSync(tmp, html);
    renameSync(tmp, options.file);
  } catch (error) {
    log(`[moons] isr: gagal regenerasi ${options.pathname}: ${String(error)}`);
  }
}

/** Test helper: bersihkan dedupe in-flight. */
export function __resetIsrInflight(): void {
  inflight.clear();
}
