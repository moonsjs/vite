export interface BundleOutputLike {
  type: string;
  fileName?: string;
  code?: string;
  source?: string | Uint8Array;
}

/**
 * §9.1 (`leakTest.canary`) / §10.4: cari canary pada output bundle client.
 * Dipakai `generateBundle` plugin — build gagal bila canary ditemukan.
 */
export function findLeak(
  outputs: Iterable<BundleOutputLike>,
  canary: string,
  decode: (source: Uint8Array) => string = defaultDecode,
): { fileName: string } | null {
  for (const output of outputs) {
    const fileName = output.fileName ?? "(unknown)";
    let text = "";
    if (typeof output.code === "string") {
      text = output.code;
    } else if (typeof output.source === "string") {
      text = output.source;
    } else if (output.source instanceof Uint8Array) {
      text = decode(output.source);
    }
    if (text.includes(canary)) {
      return { fileName };
    }
  }
  return null;
}

function defaultDecode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
