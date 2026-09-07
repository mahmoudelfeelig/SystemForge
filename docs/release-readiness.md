# Release-readiness evidence

SystemForge production releases use the two-part deployment boundary documented
in `docs/operations/production.md`. Protected CI builds, scans, checksums, and
integration-tests the exact application images. The minimal OIDC caller then
sends only the application identifier, successful source SHA, and CI run
identifier to an immutable reusable workflow.

The restricted release controller is responsible for provenance validation,
immutable image promotion, backup and restore gates, bounded application smoke
checks, routing, rollback, and signed release receipts. Machine addressing,
credentials, private paths, service placement, and recovery destinations are
not release evidence that belongs in this public repository.

Repository evidence establishes application behavior and the public caller
contract. It does not by itself establish that a release was accepted, that a
current backup is independently recoverable, or that a live endpoint is healthy.
Those claims require a controller receipt and fresh external checks for the same
source SHA.

## Current release-candidate evidence — 2026-09-07

The engine and interface revision passed one complete `pnpm quality` gate:
formatting, ESLint, TypeScript project references, 56 files and 437 functional
tests, both performance budgets, all workspace builds, and seven Sites packaging
tests. The final calibration admission guard and its negative controls are part
of that exact tested tree.

Microsoft Edge 152.0.4191.66 passed 34 desktop and mobile route audits plus ten
interaction groups with no unexpected console errors, network errors,
acceptance defects, overflow, clipped controls, unnamed controls, or duplicate
identifiers. A separate seven-test Edge workflow suite covered the Field Guide,
retained demand replay, accepted telemetry fitting and evidence, baseline
dossier, responsive navigation, and exact topology containment in both default
and focused investigation layouts.

The deterministic engine is version 0.8.0. Directed request classes execute
through topology edges; Poisson and overdispersed arrivals, G/G/c resource wait,
FIFO queue age, next-frame admission, seeded incidents, bounded paused
interventions, replay evidence, behavioral profiles, robustness, telemetry
calibration, and output/work admission are covered by the regression suite.

These are local release-candidate results, not an exact-image CI result or a
production acceptance claim. The candidate is releasable only after the pushed
SHA completes protected CI and the restricted controller returns a successful
receipt for that same SHA. Fresh public shell and readiness checks must then
confirm the accepted revision.

Historical deployment transcripts and infrastructure-specific rehearsal notes
were retired when the central controller became authoritative. Git history may
still contain earlier public text; removing files from the current revision is
not a substitute for credential rotation or history rewriting if a real secret
is ever discovered.
