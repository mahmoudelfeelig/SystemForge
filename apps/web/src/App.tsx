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
