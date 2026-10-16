import { expect, test } from "bun:test";
import { once } from "node:events";
import type { Server } from "node:http";
import { installGracefulShutdown, startNodeServer } from "@moonsjs/vite/server";

async function boundPort(server: Server): Promise<number> {
  if (!server.listening) {
    await once(server, "listening");
  }
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("server tidak punya port");
  }
  return address.port;
}

function slowHandler(delayMs: number) {
  return async (): Promise<Response> => {
    await Bun.sleep(delayMs);
    return new Response("ok");
  };
}

function hangingHandler() {
  return async (): Promise<Response> => await new Promise<Response>(() => {});
}

test("drain: request in-flight selesai dulu, lalu exit 0", async () => {
  const server = startNodeServer(slowHandler(300), { port: 0, handleSignals: false });
  try {
    const port = await boundPort(server);

    const inFlight = fetch(`http://localhost:${port}/`);
    await Bun.sleep(80); // pastikan request sudah masuk

    const exits: number[] = [];
    const logs: string[] = [];
    const shutdown = installGracefulShutdown(server, {
      timeoutMs: 5_000,
      exit: (code) => exits.push(code),
      log: (message) => logs.push(message),
    });
    shutdown("SIGTERM");

    const response = await inFlight;
    expect(await response.text()).toBe("ok");
    await Bun.sleep(100);

    expect(exits).toEqual([0]);
    expect(logs.join("\n")).toContain("full drain");
    expect(logs.join("\n")).toContain("no longer accepting connections");
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  }
});

test("drain timeout → keluar paksa exit 1", async () => {
  const server = startNodeServer(hangingHandler(), { port: 0, handleSignals: false });
  try {
    const port = await boundPort(server);
    void fetch(`http://localhost:${port}/`).catch(() => {}); // dibiarkan menggantung
    await Bun.sleep(80);

    const exits: number[] = [];
    const shutdown = installGracefulShutdown(server, {
      timeoutMs: 150,
      exit: (code) => exits.push(code),
      log: () => {},
    });
    shutdown("SIGTERM");
    await Bun.sleep(400);

    expect(exits).toEqual([1]);
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
    await Bun.sleep(50);
  }
});

test("shutdown idempoten: sinyal kedua diabaikan", async () => {
  const server = startNodeServer(slowHandler(10), { port: 0, handleSignals: false });
  try {
    await boundPort(server);
    const exits: number[] = [];
    const shutdown = installGracefulShutdown(server, {
      timeoutMs: 1_000,
      exit: (code) => exits.push(code),
      log: () => {},
    });
    shutdown("SIGTERM");
    shutdown("SIGINT");
    await Bun.sleep(100);
    expect(exits).toEqual([0]);
  } finally {
    server.close();
  }
});

test("plugins (Addendum B.4): onStart sebelum listen, onReady sesudah listen, onShutdown saat drain", async () => {
  const events: string[] = [];
  let serverRef: Server | undefined;
  const plugins = {
    app: { ready: false, version: "test" },
    async start() {
      events.push("start");
    },
    async ready() {
      events.push(`ready:listening=${serverRef?.listening === true}`);
    },
    async shutdown() {
      events.push("shutdown");
    },
    applyExtensions() {},
  };

  serverRef = startNodeServer(async () => new Response("ok"), {
    port: 0,
    handleSignals: false,
    plugins: plugins as unknown as import("@moonsjs/vite/server").PluginRuntime,
  });
  const server = serverRef;
  try {
    await boundPort(server);
    await Bun.sleep(30);
    expect(events).toEqual(["start", "ready:listening=true"]);

    const exits: number[] = [];
    const shutdown = installGracefulShutdown(server, {
      timeoutMs: 2_000,
      exit: (code) => exits.push(code),
      onShutdown: () => plugins.shutdown(),
    });
    shutdown("SIGTERM");
    await Bun.sleep(80);
    expect(events).toContain("shutdown");
    expect(exits).toEqual([0]);
  } finally {
    (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    server.close();
  }
});
