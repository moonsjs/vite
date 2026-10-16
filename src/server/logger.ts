/**
 * Addendum L.3: logger akses terstruktur — JSON default, redaksi nilai
 * query-param (mis. `?token=…`), dan target tulis injectable (untuk test).
 * Semua field tambahan diteruskan apa adanya; `path` selalu di-redaksi.
 */
export interface LogEvent {
  /** Default `info`. */
  level?: "info" | "warn" | "error";
  /** Nama event, mis. `request` atau `isr:regenerated`. */
  msg: string;
  [field: string]: unknown;
}

export interface LoggerOptions {
  /** Default `true` (JSON). `false` = teks ringkas. */
  json?: boolean;
  /** Nama query-param yang nilainya diganti `[redacted]`. */
  redact?: readonly string[];
  /** Tujuan tulis; default `console.log`. */
  write?: (line: string) => void;
}

export type Logger = (event: LogEvent) => void;

/** Ganti nilai query-param bernama `redact` menjadi `[redacted]`. */
export function redactPath(path: string, redact: readonly string[]): string {
  if (redact.length === 0 || !path.includes("?")) {
    return path;
  }
  const index = path.indexOf("?");
  const pathname = path.slice(0, index);
  const params = new URLSearchParams(path.slice(index + 1));
  let changed = false;
  for (const name of redact) {
    if (params.has(name)) {
      params.set(name, "[redacted]");
      changed = true;
    }
  }
  return changed ? `${pathname}?${params.toString()}` : path;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const json = options.json !== false;
  const redact = options.redact ?? [];
  const write = options.write ?? ((line: string): void => console.log(line));

  return (event) => {
    const fields: Record<string, unknown> = { level: "info", ...event };
    if (typeof fields["path"] === "string") {
      fields["path"] = redactPath(fields["path"], redact);
    }
    if (json) {
      write(JSON.stringify({ time: new Date().toISOString(), ...fields }));
      return;
    }
    const parts = ["[moons]", String(fields["level"]).toUpperCase(), String(fields["msg"])];
    if (fields["path"] !== undefined) {
      parts.push(String(fields["path"]));
    }
    if (fields["status"] !== undefined) {
      parts.push(String(fields["status"]));
    }
    if (fields["durationMs"] !== undefined) {
      parts.push(`${String(fields["durationMs"])}ms`);
    }
    write(parts.join(" "));
  };
}
