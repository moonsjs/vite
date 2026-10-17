import { startBunServer } from "./bun-server";
import { startNodeServer, type NodeServerOptions } from "./node-server";

/**
 * Addendum Q (3B): pemilih transport produksi.
 * Default: Bun.serve saat berjalan di Bun, node:http di Node.
 * Override eksplisit: `MOONS_SERVER=bun|node`.
 */
export function startServer(
  handler: (request: Request) => Promise<Response>,
  options: NodeServerOptions = {},
): ReturnType<typeof startNodeServer> | ReturnType<typeof startBunServer> {
  const forced = process.env["MOONS_SERVER"];
  const isBun = typeof Bun !== "undefined";

  if (forced === "node") {
    return startNodeServer(handler, options);
  }
  if (forced === "bun" && !isBun) {
    console.warn("[moons] MOONS_SERVER=bun requires the Bun runtime — falling back to node");
    return startNodeServer(handler, options);
  }
  if (forced !== undefined && forced !== "bun" && forced !== "node") {
    console.warn(`[moons] unknown MOONS_SERVER="${forced}" — using ${isBun ? "bun" : "node"}`);
  }
  return isBun ? startBunServer(handler, options) : startNodeServer(handler, options);
}
