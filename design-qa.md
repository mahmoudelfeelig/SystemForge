# SystemForge design QA

## Current acceptance snapshot

- Review date: 2026-08-09
- Approved reference: `/mnt/c/Users/mahmo/AppData/Local/Temp/codex-clipboard-ee1b35ff-9e78-466c-9316-9be45dcd670c.png`
- Earlier 1672 by 941 reference-fidelity comparison: `design-qa.local/final-qa-2026-08-09-v2/reference-implementation-comparison.png`
- Final desktop result: `test-results/browser/lab-completed-desktop.png`
- Final mobile Lab: `test-results/browser/lab-mobile-390.png`
- Final warmed-offline Replay: `test-results/browser/replay-warm-offline-390.png`
- Structured browser evidence: `test-results/browser/report.json`
- Browser: Microsoft Edge 151 at 1440 by 900 and 390 by 844 CSS pixels

The reference and implementation were compared at the same 1672 by 941
viewport. SystemForge now follows the reference's operational hierarchy: a
compact command bar, continuous primitive rail, topology-dominant workspace,
populated inspector, and persistent event, telemetry, resource, and causal
evidence band. The implementation uses real simulator state rather than copied
reference values or decorative mock data.

There are no remaining actionable P0, P1, or P2 visual, responsive, copy, or
interaction findings in the reviewed local build.

## Route and state coverage

- `/` presents SystemForge as a concrete distributed-systems lab, with direct
  Lab, scenario, interview, and replay entry points. The topology is explicitly
  labeled as a scenario preview.
- `/lab` supports blank and populated architectures, Build, Run, Pause, Step,
  intervention, Stop, completion, investigation, graph lint, undo/redo,
  responsive fit, and server-unavailable states.
- `/custom` and `/interview` use one expanded authoring section at a time,
  inline validation, candidate-safe sharing, private interviewer criteria, and
  a live scenario summary.
- `/scenario/:id` distinguishes loading, unavailable, unauthorized,
  rate-limited, service, and offline failures, with a safe local-Lab fallback.
- `/replay` validates bounded local replay bundles, explains that its hashes
  prove internal consistency rather than authorship, recomputes from second
  zero, and compares two runs at the same modeled second.
- Loading, route-crash, 404, service-unavailable, and offline shells use the
  same mission-control visual language and preserve workspace navigation.

## Reference fidelity

Typography uses self-hosted Barlow Condensed for operational headings, IBM Plex
Sans for readable UI, and IBM Plex Mono for identifiers and measurements. The
desktop command bar, left rail, graph, inspector, and lower diagnostic band map
directly to the reference proportions without copying nonexistent product
features.

The Lab keeps near-black blue surfaces, restrained cyan signal paths, semantic
green, amber, and red state treatment, hard dividers, compact spacing, and
square technical controls. Status is not color-only. The 14,640-byte blueprint
WebP replaces the previous 1.21 MB PNG deployment payload.

The mobile page has no document-level horizontal overflow. The full topology
fits before the inspector begins in normal flow; the primitive rail remains
horizontally scrollable and the canvas remains pannable and zoomable. All
reviewed first-party interactive operational text is at least 12 px. The only
smaller item is React Flow's third-party attribution metadata.

## Functional design evidence

The final browser pass audited 17 desktop, mobile, completed-run, not-found, and
warmed-offline route states. It exercised local authoring and sharing,
simulation, pause, single-step, future intervention, snapshot/fork restoration,
completion, trace selection, timeline seeking, replay export/import/integrity
checks/comparison/re-execution, automatic candidate-safe Run library
persistence, and interviewer-versus-candidate privacy.
Evidence-linked playback highlights the exact graph nodes and links associated
with each sampled span, synchronizes the Inspector, supports
previous/next/play/pause/scrub and keyboard controls, and honors reduced motion.

The reviewed desktop and mobile sessions recorded:

- zero document-level horizontal overflow;
- zero unnamed focusable controls;
- zero duplicate DOM IDs;
- zero application console errors or failed application network requests;
- visible keyboard focus and reduced-motion behavior;
- no command-bar, graph, inspector, or telemetry overlap;
- 12 px or larger reviewed first-party mobile operational text and 40 px or
  larger reviewed mobile primary touch targets;
- successful cached navigation to Lab, Scenario, Interview, and Replay after a
  cache-busted API request proved the browser transport was offline.

These are browser-rendered interaction checks, not a claim of a complete
assistive-technology certification or production-host verification.

## Engineering evidence

The final documentation-ready working tree passed a fresh complete `pnpm
quality` run after the bounded Cloudflare provider and edge-header changes:

- formatting, ESLint with zero warnings, and TypeScript project references;
- 52 files and 412 functional tests;
- both isolated performance tests, including 250 representative simulations
  and five bounded solver runs within their separate two-second measured
  budgets;
- all workspace builds; the web build transformed 4,886 modules and preserved
  worker and route code splitting;
- 7 Sites packaging and edge-routing tests.

A separate fresh `pnpm test:coverage` run passed all 412 tests and reported
92.72% statements, 84.54% branches, 93.54% functions, and 93.73% lines across
the configured critical-file denominator. The repository thresholds remain
92%, 84%, 93%, and 93% respectively. Four targeted mutants were killed, and
the complete non-performance suite also passed serial and parallel fixed-seed
stability runs without retry.

Independent UI and source acceptance reviews found no surviving
source-confirmed or browser-confirmed P0, P1, or P2 issue in the current local
checkout. This does not claim screen-reader certification, physical-device
installation, a real AI-provider transaction, or hosted production behavior.
Hosted production is evaluated separately in `docs/release-readiness.md` and
is not covered by this pass.

final result: passed
