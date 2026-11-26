# ADR 0003: Open core licensing

- Status: accepted (to be reviewed by a lawyer before public launch)
- Date: 2026-11-26

## Decision

- Code (engine, apps, tools): GPL-3.0-or-later.
- Style library (`packages/styles`): all rights reserved; sold as style packs.
- Contributors sign a CLA so the project can relicense and sell.
- No vendor (Yamaha/Korg/Roland) style files in the repository, ever.

## Consequences

- Others may fork the code but must keep forks open.
- GPL complicates Apple App Store distribution; revisit before an iOS app.
