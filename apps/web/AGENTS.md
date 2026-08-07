# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## SystemForge product direction

- The selected visual target is the user-provided Mission Control screenshot at `C:/Users/mahmo/AppData/Local/Temp/codex-clipboard-bd6d59a6-0999-4836-bd94-a39223a060e6.png`.
- Preserve its compact dark operations-center composition, architecture-first hierarchy, contextual inspector, and bottom telemetry timeline.
- Improve it with explicit Build, Run, and Investigate modes, non-color-only health states, readable control sizes, and graceful local-only operation when the API is unavailable.
- Guided, custom, and interview scenarios must use the same modular workspace. Interview mode hides interviewer requirements and lets candidates record derived requirements.
- The screenshot is a strong guide rather than a pixel-locked final; changes must improve clarity, accessibility, or the product workflow.
