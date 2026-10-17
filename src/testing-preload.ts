import { registerMoonsTestPlugin } from "./testing";

// Marker so fixture tests can skip cleanly under a plain `bun test` run.
(globalThis as { __moonsTestPreload?: boolean }).__moonsTestPreload = true;
registerMoonsTestPlugin();
