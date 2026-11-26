# ADR 0001: One TypeScript monorepo with a platform-free engine

- Status: accepted
- Date: 2026-11-26

## Context

EkidongoMIDI must run as a web app (Chrome/Edge on Windows and Android), a Windows desktop app and later mobile apps, built by one developer working with Claude.

## Decision

- One repository, pnpm workspaces: `packages/engine`, `packages/styles`, `apps/*`, `tools/`.
- The engine is pure TypeScript with no DOM, Node or MIDI APIs; platforms plug in through adapters.
- Packages are consumed as TypeScript source (no build step for libraries); Node 24+ runs `.ts` tools directly via type stripping, so only erasable TypeScript syntax is allowed (`erasableSyntaxOnly`).
- pnpm (version pinned in `packageManager`): strict dependency isolation, fast installs, and install scripts blocked unless listed under `allowBuilds` in `pnpm-workspace.yaml`.

## Consequences

- One language and one test runner (Vitest) everywhere.
- No enums or namespaces (not erasable); use `as const` objects and unions instead.
- The desktop app (Tauri) adds a Rust toolchain in Phase 2; it isn't needed before then.
