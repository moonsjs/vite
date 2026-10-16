import type { Server } from "node:http";

export interface ShutdownOptions {
  /** Batas drain sebelum keluar paksa (default 10_000 ms). */
  timeoutMs?: number;
  log?: (message: string) => void;
  /** Injectable untuk test; default `process.exit`. */
  exit?: (code: number) => void;
  /**
   * Dipanggil setelah drain penuh, sebelum exit (Addendum B.4: onShutdown
   * plugin). Berbagi batas waktu dengan drain; error dilaporkan, tidak
   * menggagalkan shutdown.
   */
  onShutdown?: () => void | Promise<void>;
}

/**
 * Graceful shutdown (PRD §19.5): SIGTERM/SIGINT → stop menerima koneksi baru →
 * drain request berjalan → exit 0. Melewati timeout → keluar paksa exit 1.
 *
 * Handler dipasang `once` oleh pemanggil, sehingga sinyal kedua memakai
 * perilaku default (proses langsung berhenti).
 */
export function installGracefulShutdown(
  server: Server,
  options: ShutdownOptions = {},
): (signal: NodeJS.Signals) => void {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const log = options.log ?? ((message: string) => console.log(message));
  const exit = options.exit ?? ((code: number) => process.exit(code));

  let shuttingDown = false;

  return (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`[moons] menerima ${signal} — berhenti menerima koneksi, drain...`);

    const timer = setTimeout(() => {
      log(`[moons] drain melewati ${timeoutMs}ms — keluar paksa`);
      const closeAll = (server as { closeAllConnections?: () => void }).closeAllConnections;
      try {
        closeAll?.call(server);
      } catch {
        // abaikan: keluar paksa tetap jalan
      }
      exit(1);
    }, timeoutMs);
    timer.unref?.();

    try {
      (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    } catch {
      // abaikan: fallback timeout tetap ada
    }

    server.close(async (error?: Error) => {
      if (error !== undefined) {
        clearTimeout(timer);
        log(`[moons] penutupan server gagal: ${error.message}`);
        exit(1);
        return;
      }
      if (options.onShutdown !== undefined) {
        // Tetap berbagi batas waktu dengan drain: timer di-ref kembali agar
        // proses tidak keluar sebelum hook selesai.
        (timer as { ref?: () => void }).ref?.();
        try {
          await options.onShutdown();
        } catch (hookError) {
          log(`[moons] onShutdown gagal: ${String(hookError)}`);
        }
      }
      clearTimeout(timer);
      log("[moons] shutdown selesai (drain penuh)");
      exit(0);
    });
  };
}
