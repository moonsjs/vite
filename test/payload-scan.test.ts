import { expect, test } from "bun:test";
import { scanPayloadForSecrets } from "../src/payload-scan";

test("scanPayloadForSecrets: canary + env mirip-rahasia (min 12 char), dedupe pola", () => {
  const payload = '{"data":{"token":"ssr-secret-value-123456","canary":"MOONS_CANARY_X"}}';

  const findings = scanPayloadForSecrets(payload, {
    canary: "MOONS_CANARY_X",
    env: {
      DB_SECRET: "ssr-secret-value-123456",
      TOKEN_SHORT: "pendek", // < 12 char → diabaikan
      PUBLIC_KEY: "public-key-value-12345", // PUBLIC → diabaikan
      NODE_ENV: "production", // nama tidak mirip rahasia
      PATH: "/usr/local/bin:/usr/bin",
    },
  });

  const labels = findings.map((finding) => `${finding.kind}:${finding.label}`).sort();
  expect(labels).toEqual(["canary:canary", "env:DB_SECRET"]);
});

test("scanPayloadForSecrets: payload bersih → tanpa temuan; tanpa opsi → aman", () => {
  expect(scanPayloadForSecrets('{"data":{"note":"biasa"}}', { env: {} })).toEqual([]);
  expect(scanPayloadForSecrets('{"data":1}')).toEqual([]);
  expect(scanPayloadForSecrets("apa saja", { canary: "" })).toEqual([]);
});

test("scanPayloadForSecrets: nilai env yang panjang tapi bukan rahasia tetap aman", () => {
  const findings = scanPayloadForSecrets(
    "ganti-rugi-dan-laba-perusahaan-tahun-2026",
    { env: { COMPANY_TAGLINE: "ganti-rugi-dan-laba-perusahaan-tahun-2026" } },
  );
  expect(findings).toEqual([]);
});
