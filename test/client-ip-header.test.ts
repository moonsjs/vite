import { expect, test } from "bun:test";
import { request as httpRequest, type Server } from "node:http";
import { startBunServer, startNodeServer } from "@moonsjs/vite/server";

/**
 * Addendum S (integrasi Cloudflare): `security.clientIpHeader` — header
 * tepercaya untuk IP klien saat trustProxy aktif. Di belakang CF, XFF di-append
 * sehingga entri pertama bisa dipalsukan; `cf-connecting-ip` authoritative.
 */

const CLIENT_IP_HEADER = "x-moons-client-ip";

interface ServerOptions {
  trustProxy?: boolean;
  clientIpHeader?: string;
}

async function startNode(
  handler: (request: Request) => Promise<Response>,
  options: ServerOptions,
): Promise<{ server: Server; port: number }> {
  const server = startNodeServer(handler, { ...options, port: 0, handleSignals: false });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, port };
}

function nodeGet(port: number, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/whoami", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
}

async function bunGet(port: number, headers: Record<string, string>): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${port}/whoami`, { headers });
  return response.text();
}

const handler = async (request: Request): Promise<Response> =>
  new Response(request.headers.get(CLIENT_IP_HEADER) ?? "none");

for (const transport of ["node:http", "Bun.serve"] as const) {
  test(`S: ${transport} — clientIpHeader tepercaya menang atas XFF palsu`, async () => {
    const run = async (headers: Record<string, string>): Promise<string> => {
      if (transport === "node:http") {
        const { server, port } = await startNode(handler, {
          trustProxy: true,
          clientIpHeader: "cf-connecting-ip",
        });
        try {
          return await nodeGet(port, headers);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
      const server = startBunServer(handler, {
        port: 0,
        handleSignals: false,
        trustProxy: true,
        clientIpHeader: "cf-connecting-ip",
      });
      try {
        return await bunGet(server.port, headers);
      } finally {
        await server.stop(true);
      }
    };

    // 1) XFF palsu + header CF asli → header CF yang dipakai.
    expect(
      await run({ "x-forwarded-for": "6.6.6.6", "cf-connecting-ip": "203.0.113.7" }),
    ).toBe("203.0.113.7");

    // 2) Hanya XFF palsu (header CF absen) → fallback socket, bukan XFF.
    expect(await run({ "x-forwarded-for": "6.6.6.6" })).toBe("127.0.0.1");

    // 3) Nilai header CF tidak plausibel → fallback socket.
    expect(await run({ "cf-connecting-ip": "evil" })).toBe("127.0.0.1");
  });

  test(`S: ${transport} — tanpa clientIpHeader perilaku lama (XFF pertama)`, async () => {
    const headers = { "x-forwarded-for": "6.6.6.6" };
    if (transport === "node:http") {
      const { server, port } = await startNode(handler, { trustProxy: true });
      try {
        expect(await nodeGet(port, headers)).toBe("6.6.6.6");
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      return;
    }
    const server = startBunServer(handler, { port: 0, handleSignals: false, trustProxy: true });
    try {
      expect(await bunGet(server.port, headers)).toBe("6.6.6.6");
    } finally {
      await server.stop(true);
    }
  });
}
