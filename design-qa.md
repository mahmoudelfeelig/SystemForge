# SystemForge full-reference design QA

## Comparison target

- Source visual truth: `/mnt/c/Users/mahmo/AppData/Local/Temp/codex-clipboard-ee1b35ff-9e78-466c-9316-9be45dcd670c.png`
- User-supplied baseline comparison: `/mnt/c/Users/mahmo/AppData/Local/Temp/codex-clipboard-cccf4c60-9094-4214-863a-0a0270cadda1.png`
- Browser-rendered implementation: `design-qa.local/lab-reference-viewport.png`
- Full same-viewport comparison: `design-qa.local/reference-fidelity-comparison.png`
- Focused region comparison: `design-qa.local/focused-reference-comparison.png`
- Responsive evidence: `design-qa.local/responsive-1024.png` and `design-qa.local/responsive-390.png`

The source and implementation are both 1672 by 941 physical pixels. The
implementation was captured from Microsoft Edge at a 1672 by 941 CSS viewport,
device scale factor 1. No density scaling or aspect-ratio normalization was
required. The full comparison places the images at their original size. The
focused board uses identical source coordinates for the topology (222,58 to
1342,631), inspector (1342,58 to 1672,631), and bottom diagnostics (222,631 to
1672,941).

The implementation state is a completed browser-local Black Friday Checkout
simulation in Investigate mode with PostgreSQL Primary selected. It contains 26
real causal events, current simulation metrics, live component state, resource
history, objective outcomes, and the release lock. No canonical service or
production environment was used.

## Findings

There are no remaining actionable P0, P1, or P2 visual findings.

- P3: The source shows separate Checkout Service and Read Replicas nodes.
  SystemForge's current architecture models checkout behavior in the API service
  and replica behavior in database configuration and metrics. Those source nodes
  were not fabricated solely for visual similarity.
- P3: The source devotes the lower left rail to events, while SystemForge keeps
  mission requirements there and places events at the start of the bottom
  diagnostic row. This preserves the existing product information architecture
  and keeps requirements visible during architecture decisions.
- P3: The header retains Build, Run, Investigate, local/canonical controls, and
  the release lock instead of copying the source's playback and speed controls.
  These controls represent real SystemForge behavior and remain deliberately
  more prominent.
- P3: At 390 px the complete architecture begins at a small fit-to-view scale.
  The canvas remains pan-and-zoom capable, the component rail scrolls
  horizontally, and the document itself does not require horizontal scrolling.

## Required fidelity surfaces

### Fonts and typography

The implementation uses self-hosted Barlow Condensed 600/700 for operational
headings, IBM Plex Sans 400/500/600 for controls and readable text, and IBM Plex
Mono 400/500 for identifiers, metrics, timestamps, axes, and state labels. The
condensed titles, tight uppercase tracking, numeric alignment, small-label
hierarchy, and truncation behavior closely follow the reference. The desktop
capture shows no overlapping or illegibly wrapped labels.

### Spacing and layout rhythm

The reference's 58 px command bar, 222 px left rail, 330 px inspector, dominant
topology field, and 310 px diagnostic band now map directly to the implementation
at the same viewport. The topology canvas excludes its command strip from the
ReactFlow fit bounds, so all nodes remain inside the graph region. Hard dividers,
small gaps, square corners, and dense rows replace generic cards and unused
space.

### Colors and visual tokens

The Lab now scopes a near-black blue background, navy instrument surfaces,
muted blue-gray dividers, controlled cyan flow, luminous healthy green, sharp
warning amber, and intense critical red. State color is reinforced by icons,
labels, borders, utilization bars, and line behavior. Glow is limited to active
nodes, state indicators, and signal paths. There are no decorative gradients,
glass surfaces, purple startup treatments, or excessive shadows.

### Image quality and asset fidelity

The reference consists of application chrome rather than illustrations or
product imagery. The topology uses the existing high-resolution
`blueprint-grid.png` asset behind real ReactFlow components. Icons come from the
project's Phosphor icon library. Sparklines and both diagnostic charts render
actual simulation frames; no screenshot fragments, placeholder art, CSS
illustrations, custom SVG substitutes, or fake chart images are present.

### Copy and content

Visible labels describe real SystemForge concepts: scenario mode, system
primitives, mission objectives, resource envelopes, causal events, derived
health, impacted services, telemetry, release state, score, seed, and canonical
availability. The source's component names are only used where they correspond
to the existing architecture. Dynamic values come from the simulator rather
than copied reference numbers.

### Icons, state, behavior, and accessibility

The shield brand mark, component glyphs, state icons, mode icons, and causal
symbols all use one icon family and align to the compact technical grid. The
resource tabs are functional and update real CPU, memory, network, and disk
histories. Event and causal-path rows seek the real timeline. Runtime primitive
rows show placed-component metrics and state, while Build mode continues to add
new primitives.

Status is not color-only. Existing focus-visible outlines, semantic controls,
labels, reduced-motion handling, and icon-plus-text states remain. At 1024 px and
390 px the document has no visual horizontal overflow; narrow layouts sequence
the topology, inspector, events, system telemetry, resource telemetry, and
causal analysis vertically. This is a rendered design and interaction check, not
a claim of a complete assistive-technology audit.

## Comparison history

### User-supplied baseline

- P1: The baseline right-side implementation was flatter and visually quieter
  than the source, with low-contrast nodes, weak signal paths, an empty-feeling
  canvas, and a secondary-looking chart. The new state uses luminous semantic
  borders, real node sparklines, direction markers, animated dash flow, a visible
  blueprint field, and denser graph placement.
- P1: The baseline inspector lacked the source's analytical rhythm. The revised
  overview now uses a derived health score, three compact live histories, a
  five-row signal ledger, and four current impacted services within the visible
  panel height.
- P1: The bottom region lacked the source's resource and causal depth. The final
  row now contains events, the primary marked telemetry timeline, a functional
  per-component resource chart, and a causal evidence rail with root signal.

### Full-resolution implementation pass

- P1: The primitive rail still read as a static add-component menu during an
  active run. It was reorganized into source-aligned system groups and now shows
  real per-kind metrics, health indicators, and runtime selection behavior while
  preserving Build-mode creation.
- P2: Increasing the bottom diagnostic band to match the source initially let
  upper and lower topology nodes touch the command and telemetry boundaries.
  ReactFlow was moved into an explicit 48 px inset viewport, database/cache cards
  received role-appropriate widths, and lower node positions were rebalanced.
  The final same-viewport capture shows every node fully inside the topology.
- P2: The first expanded inspector required scrolling before impacted services
  became visible. KPI, sparkline, ledger, and impact-row rhythm was tightened;
  all four impact rows are visible in the final desktop capture.

### Final comparison pass

- The full 1672 by 941 board was regenerated after the topology and inspector
  fixes and shows the complete source and implementation without cropping.
- Focused same-coordinate crops confirm topology/node anatomy, the complete
  inspector hierarchy, and the full events/telemetry/resource/causal band.
- Fresh Microsoft Edge responsive captures cover 1024 by 900 and 390 by 844.
- The final desktop run recorded zero console errors and zero failed network
  requests.
- No deployment, public share, DNS change, or production-access action occurred.

## Primary interactions tested

- Load the Lab and run the complete deterministic simulation locally.
- Enter Investigate mode and select PostgreSQL Primary.
- Render all 26 causal events and seek the timeline through event controls.
- Switch among CPU, memory, network, and disk resource histories.
- Follow the automatically selected latest critical causal chain and activate a
  causal event.
- Verify the inspector overview, config/metrics/why tabs, release-locked
  canonical action, responsive component rail, and pan-and-zoom topology.

## Engineering verification

- `pnpm --filter @systemforge/web test`: 6 files and 23 tests passed.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with zero warnings.
- `pnpm --filter @systemforge/web build`: passed; 4,850 modules transformed and
  the existing local Sites packaging artifacts were prepared.
- `pnpm --filter @systemforge/web test:sites`: 4 tests passed.

final result: passed
