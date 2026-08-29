# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## SystemForge product direction

- The selected visual target is the user-provided Mission Control screenshot retained with the design review.
- Use the full-resolution operational reference retained with the same review for final fidelity checks. Its top command bar, live primitive telemetry, multi-panel diagnostics, and causal analysis are intentional targets, but do not invent simulator components merely to copy its labels.
- Preserve its compact dark operations-center composition, architecture-first hierarchy, contextual inspector, and bottom telemetry timeline.
- Improve it with explicit Build, Run, and Investigate modes, non-color-only health states, readable control sizes, and graceful local-only operation when the API is unavailable.
- Guided, custom, and interview scenarios must use the same modular workspace. Interview mode hides interviewer requirements and lets candidates record derived requirements.
- The screenshot is a strong guide rather than a pixel-locked final; changes must improve clarity, accessibility, or the product workflow.
- The user explicitly rejected the first implementation as too cheap, basic and AI-generic. Do not fall back to a centered marketing hero, generic dashboard cards, bento sections, glass effects, purple-blue gradients, decorative blobs, excessive rounding, stock illustrations, arbitrary motion, or large empty premium-looking sections.
- The durable visual concept is an engineering mission-control workbench: blueprint precision while building, vivid operations-center behavior while running, and a causal time machine while investigating. Use a recurring signal-path motif, asymmetric composition, dense but legible technical typography, and state colors that communicate system behavior rather than decoration.
- Follow the reference closely in the lab: keep the component rail continuous, make the topology the dominant surface, maintain a fully populated right-side diagnostic inspector, and place the event list beside a marked telemetry timeline beneath the topology.
- Do not give every component the same card anatomy or accent. Component family colors, health borders, primary measurements, sparklines, ports, and dimensions should make role and state understandable before reading the label.
- Events need severity-specific rows and functional timeline markers. The right inspector needs compact history charts and evidence density rather than a large empty overview.
- The architecture and its evidence are the visual centerpiece. Scenario authoring and interview facilitation should feel like operational dossiers and test plans, not ordinary SaaS forms.
- Production must remain release-gated through the restricted central controller. The public repository may request a release only after exact protected CI succeeds and must never receive direct machine access or long-lived deployment credentials.
