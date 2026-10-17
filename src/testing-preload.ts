import { registerMoonsTestPlugin } from "./testing";

// Marker so fixture tests can skip cleanly under a plain `bun test` run.
(globalThis as { __moonsTestPreload?: boolean }).__moonsTestPreload = true;

// Preload the SSR renderer so request handling never awaits a pending import
// inside a request (Bun drops AsyncLocalStorage contexts in that case).
try {
  const ssr = (await import("@moonsjs/react/ssr")) as {
    renderToMarkup?: unknown;
  };
  if (typeof ssr.renderToMarkup === "function") {
    (globalThis as { __moons_renderToMarkup?: unknown }).__moons_renderToMarkup = ssr.renderToMarkup;
  }
} catch {
  // Consumer installs may not resolve peers here; the test server injects its
  // own app-resolved renderer instead.
}

registerMoonsTestPlugin();
