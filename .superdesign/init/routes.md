# Route map

SystemForge uses React Router 7 inside a Vite SPA. Every route renders directly inside the root Suspense boundary; there is no separate nested layout.

| URL | Component | Source | Layout |
| --- | --- | --- | --- |
| `/` | `LandingPage` | `apps/web/src/pages/LandingPage.tsx` | Page-owned site header, mission sections, footer |
| `/lab` | `LabPage` | `apps/web/src/pages/LabPage.tsx` | Full-viewport mission-control shell |
| `/custom` | `ScenarioDesignerPage mode="custom"` | `apps/web/src/pages/ScenarioDesignerPage.tsx` | Page-owned designer header, rail, contract workspace |
| `/interview` | `ScenarioDesignerPage mode="interview"` | `apps/web/src/pages/ScenarioDesignerPage.tsx` | Page-owned designer header, rail, private facilitation workspace |
| `/scenario/:id` | `SharedScenarioPage` | `apps/web/src/pages/SharedScenarioPage.tsx` | Compact shared-scenario loading/error handoff |
| `*` | Redirect | `apps/web/src/App.tsx` | Redirects to `/` |

## Router source

```tsx
import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { LandingPage } from "./pages/LandingPage";

const LabPage = lazy(() =>
  import("./pages/LabPage").then((module) => ({ default: module.LabPage })),
);
const ScenarioDesignerPage = lazy(() =>
  import("./pages/ScenarioDesignerPage").then((module) => ({
    default: module.ScenarioDesignerPage,
  })),
);
const SharedScenarioPage = lazy(() =>
  import("./pages/SharedScenarioPage").then((module) => ({
    default: module.SharedScenarioPage,
  })),
);

export function App() {
  return (
    <Suspense
      fallback={<main className="route-loader">Preparing workspace…</main>}
    >
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/lab" element={<LabPage />} />
        <Route
          path="/custom"
          element={<ScenarioDesignerPage mode="custom" />}
        />
        <Route
          path="/interview"
          element={<ScenarioDesignerPage mode="interview" />}
        />
        <Route path="/scenario/:id" element={<SharedScenarioPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
```
