# Security Policy

## Supported versions

The latest minor release line receives security fixes. Older lines are patched
only when the issue also affects the current line.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

  https://github.com/moonsjs/vite/security/advisories/new

Do not open a public issue for a suspected vulnerability. Include the affected
package and version, a reproduction, the impact, and any suggested fix.

We aim to acknowledge within 72 hours and to ship a fix or a documented
mitigation within 14 days for confirmed high or critical issues.

## In scope

- Any way server-only code, secrets, or `env()` values can reach
  `dist/client/**` or the browser (the core guarantee).
- Bypasses of the build transform or import rejection rules (PRD section 12).
- RPC and API contract issues: origin checks, body limits, schema drift.
- Insecure behavior in hardening defaults (security headers, cookies, rate
  limiting, `security.trustProxy`).
- Supply chain: published tarballs, build provenance, dependency handling.

## Out of scope (by design)

- Loader data embedded in the HTML response. It travels to the browser on
  purpose; never return secrets from a loader.
- Input and output schemas shipped to the client so both sides can validate.
- The absence of features the framework lists as non-goals: RSC, streaming,
  form actions, auth/session, ORM, image/font optimization, edge adapters.

## Deployment guidance

- Keep framework packages current and run `moons audit` in CI.
- Read the security model: https://docs.devmoon.net/architecture and
  https://docs.devmoon.net/core-concepts/zero-trust
