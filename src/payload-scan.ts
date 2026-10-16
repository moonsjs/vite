/**
 * Pemindaian payload SSR (nilai A1 / PRD §2): HANYA dipakai di dev sebagai
 * peringatan — tidak ada biaya runtime di production (production tidak pernah
 * memanggil fungsi ini; lihat `RequestHandlerOptions.payloadScan`).
 */

export interface PayloadScanOptions {
  /** Canary `leakTest.canary` (bila dikonfigurasi). */
  canary?: string;
  /** Lingkungan server (biasanya `process.env`). */
  env?: Record<string, string | undefined>;
}

export interface PayloadScanFinding {
  kind: "canary" | "env";
  /** Label untuk pesan: `canary` atau nama env var. */
  label: string;
}

/**
 * Nama env yang "mirip rahasia" — dideteksi lewat pola nama + panjang nilai
 * minimum 12 karakter untuk menghindari false positive (keputusan pemilik).
 */
const SECRET_KEY_PATTERN =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|API_KEY|ACCESS_KEY|SIGNING)/i;

const MIN_SECRET_LENGTH = 12;

export function scanPayloadForSecrets(
  payload: string,
  options: PayloadScanOptions = {},
): PayloadScanFinding[] {
  const findings: PayloadScanFinding[] = [];

  const canary = options.canary;
  if (canary !== undefined && canary.length > 0 && payload.includes(canary)) {
    findings.push({ kind: "canary", label: "canary" });
  }

  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) {
      continue;
    }
    if (!SECRET_KEY_PATTERN.test(key) || /PUBLIC/i.test(key)) {
      continue;
    }
    if (payload.includes(value)) {
      findings.push({ kind: "env", label: key });
    }
  }

  return findings;
}
