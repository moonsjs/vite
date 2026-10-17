# Changelog

All notable changes to this package. Entries mirror commit subjects;
releases are tagged `vX.Y.Z` in the package repository.

Format: [Keep a Changelog](https://keepachangelog.com/). Versioning: see
`governance/versioning.md` in the Moons hub.

## v0.2.5 — 2026-10-17
- renderer statis di entry dev/build/prerender + default lazily (tanpa dynamic import dalam request)

## v0.2.4 — 2026-10-17
- prefer a preloaded renderer (no await-in-request for ALS safety)

## v0.2.3 — 2026-10-17
- default renderer resolves at module load (AsyncLocalStorage-safe)

## v0.2.2 — 2026-10-17
- test renderer prefers the app's source instance (single module graph)

## v0.2.1 — 2026-10-17
- lazy renderer for test server (registry/cache peer resolution)

## v0.2.0 — 2026-10-17
- testing entry, dev health parity; deps ^0.2.0

## v0.1.18 — 2026-10-16
- @moonsjs/vite@0.1.18 — output English (Addendum N; lock core 0.1.14)

## v0.1.17 — 2026-10-16
- @moonsjs/vite@0.1.17 — trailingSlash 308 di handler + transport (Addendum M; lock core 0.1.13)

## v0.1.16 — 2026-10-16
- @moonsjs/vite@0.1.16 — logger akses terstruktur + event ISR (Addendum L.3; lock core 0.1.12)

## v0.1.15 — 2026-10-16
- @moonsjs/vite@0.1.15 — F1: fallback dist/client saat isr.storage MISS (storage tetap menang; regen fallback menulis ke storage)

## v0.1.14 — 2026-10-16
- @moonsjs/vite@0.1.14 — K.1 pesan Moons untuk rantai re-export barrel; K.5 ETag/304 + gzip static (Addendum K)

## v0.1.13 — 2026-10-16
- @moonsjs/vite@0.1.13 — hardening transport (trustProxy, batas body streaming, guard config/src-server, type-only import, default header) — Addendum J (lock core 0.1.11)

## v0.1.12 — 2026-10-16
- feat: devtools overlay dev-only /__moons/devtools (Addendum I.4/W4) — routes + fn registry + status payload-scan

## v0.1.11 — 2026-10-16
- @moonsjs/vite@0.1.11 — PrerenderStorage + serving ISR lewat storage (Addendum I/W2, lock core 0.1.10)

## v0.1.10 — 2026-10-16
- @moonsjs/vite@0.1.10 — header config menempel di halaman prerender (mode server)

## v0.1.9 — 2026-10-16
- fix: pulihkan range ^0.1.0 + lockfile standalone (core 0.1.8) — insiden workspace-rewrite
- chore: lockfile — @moonsjs/core 0.1.8 (dibutuhkan config deploy kit)
- @moonsjs/vite@0.1.9 — deploy kit statis + hook/header/redirect runtime (Addendum H)

## v0.1.8 — 2026-10-16
- @moonsjs/vite@0.1.8 — static export: 404.html saat prerender (Addendum G)

## v0.1.7 — 2026-10-16
- @moonsjs/vite@0.1.7 — validasi trusted publishing (tanpa perubahan fungsional)
- @moonsjs/vite 0.1.6 — initial public source (split from the Moons development repo)
