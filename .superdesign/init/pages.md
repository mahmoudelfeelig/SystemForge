# Page dependency trees

## `/` Landing page

Entry: `apps/web/src/pages/LandingPage.tsx`

Dependencies:
- `apps/web/src/pages/LandingPage.tsx`
  - `@phosphor-icons/react`
  - `react-router-dom`
  - `apps/web/src/styles.css` (loaded by the application entry)

## `/lab` Mission control

Entry: `apps/web/src/pages/LabPage.tsx`

Dependencies:
- `apps/web/src/pages/LabPage.tsx`
  - `apps/web/src/components/ComponentNode.tsx`
    - `apps/web/src/components/componentIcons.tsx`
  - `apps/web/src/components/InspectorPanel.tsx`
  - `apps/web/src/components/ServiceBanner.tsx`
    - `apps/web/src/lib/api.ts`
  - `apps/web/src/components/TelemetryPanel.tsx`
  - `apps/web/src/components/componentIcons.tsx`
  - `apps/web/src/lib/share.ts`
  - `apps/web/src/store/useLabStore.ts`
    - `apps/web/src/lib/api.ts`
    - `apps/web/src/lib/localSimulation.ts`
    - `apps/web/src/lib/share.ts`
    - `packages/contracts/src/index.ts`
    - `packages/sim-core/src/index.ts`
  - `apps/web/src/styles.css`

## `/custom` Challenge studio

Entry: `apps/web/src/pages/ScenarioDesignerPage.tsx` with `mode="custom"`.

Dependencies:
- `apps/web/src/pages/ScenarioDesignerPage.tsx`
  - `apps/web/src/lib/api.ts`
  - `apps/web/src/lib/share.ts`
  - `apps/web/src/store/useLabStore.ts`
    - `apps/web/src/lib/localSimulation.ts`
  - `packages/contracts/src/index.ts`
  - `packages/sim-core/src/defaults.ts`
  - `apps/web/src/styles.css`

## `/interview` Interview studio

Entry: `apps/web/src/pages/ScenarioDesignerPage.tsx` with `mode="interview"`.

Dependencies are identical to `/custom`; the render branch adds the candidate brief, private evaluation brief, timebox, reveal policy, candidate-derived requirement policy, and separate candidate/interviewer links.

## `/scenario/:id` Shared scenario handoff

Entry: `apps/web/src/pages/SharedScenarioPage.tsx`.

Dependencies:
- `apps/web/src/pages/SharedScenarioPage.tsx`
  - `apps/web/src/lib/api.ts`
  - `apps/web/src/store/useLabStore.ts`
    - `apps/web/src/lib/localSimulation.ts`
    - `apps/web/src/lib/share.ts`
  - `apps/web/src/styles.css`
