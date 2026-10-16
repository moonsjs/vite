/**
 * Addendum I.4 (W4): devtools overlay dev-only — tabel route, registry
 * serverFn (hash §12), endpoint `src/api`, dan status payload-scan.
 * Renderer murni (tanpa I/O) supaya bisa diuji unit; middleware dev yang
 * menyajikannya di `/__moons/devtools`.
 */

export interface DevtoolsRoute {
  /** Path URL (bentuk PRD §6.1), mis. "/users/:id". */
  path: string;
  /** "page" | "layout" | "error" | "404" | "middleware" | "api". */
  kind: string;
  /** Path relatif terhadap root app (posix). */
  file: string;
}

export interface DevtoolsFn {
  file: string;
  name: string;
  hash: string;
}

export interface DevtoolsData {
  routes: DevtoolsRoute[];
  apiRoutes: DevtoolsRoute[];
  serverFns: DevtoolsFn[];
  /** Canary `leakTest` terpasang → payload-scan aktif (A1). */
  canary: boolean;
  version: string;
}

export function emptyDevtoolsData(): DevtoolsData {
  return { routes: [], apiRoutes: [], serverFns: [], canary: false, version: "" };
}

export function renderDevtoolsHtml(data: DevtoolsData): string {
  const rows = (items: DevtoolsRoute[]): string =>
    items.length === 0
      ? '<tr><td colspan="3" class="muted">(kosong)</td></tr>'
      : items
          .map(
            (item) =>
              `<tr><td><code>${esc(item.path)}</code></td><td><span class="kind k-${esc(item.kind)}">${esc(item.kind)}</span></td><td class="muted">${esc(item.file)}</td></tr>`,
          )
          .join("\n");

  const fnRows =
    data.serverFns.length === 0
      ? '<tr><td colspan="3" class="muted">(tidak ada serverFn)</td></tr>'
      : data.serverFns
          .map(
            (fn) =>
              `<tr><td><code>${esc(fn.hash)}</code></td><td><code>${esc(fn.name)}</code></td><td class="muted">${esc(fn.file)}</td></tr>`,
          )
          .join("\n");

  const canary = data.canary
    ? '<span class="ok">aktif</span> (canary terpasang)'
    : '<span class="muted">nonaktif</span> (tanpa canary)';

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>moons devtools</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 2rem; background: #101418; color: #e6edf3;
         font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; }
  h2 { font-size: .95rem; margin: 2rem 0 .5rem; color: #9fb0c0; }
  .muted { color: #8b98a5; }
  .ok { color: #3fb950; font-weight: 600; }
  .meta { margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; max-width: 1100px; }
  th, td { text-align: left; padding: .35rem .75rem .35rem 0; border-bottom: 1px solid #1f2630; }
  th { color: #8b98a5; font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; }
  code { color: #79c0ff; }
  .kind { border: 1px solid #30363d; border-radius: 4px; padding: 0 .35rem; font-size: .8rem; }
  .k-page { color: #d2a8ff; } .k-layout { color: #7ee787; }
  .k-error { color: #ff7b72; } .k-404 { color: #ff7b72; }
  .k-middleware { color: #e3b341; } .k-api { color: #79c0ff; }
</style>
</head>
<body>
<h1>moons devtools</h1>
<div class="meta muted">@moonsjs/vite ${esc(data.version)} · dev-only · payload-scan: ${canary}</div>

<h2>Routes (${data.routes.length})</h2>
<table><thead><tr><th>path</th><th>kind</th><th>file</th></tr></thead>
<tbody>
${rows(data.routes)}
</tbody></table>

<h2>API (${data.apiRoutes.length})</h2>
<table><thead><tr><th>path</th><th>kind</th><th>file</th></tr></thead>
<tbody>
${rows(data.apiRoutes)}
</tbody></table>

<h2>serverFn registry (${data.serverFns.length})</h2>
<table><thead><tr><th>hash</th><th>export</th><th>file</th></tr></thead>
<tbody>
${fnRows}
</tbody></table>
</body>
</html>
`;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
