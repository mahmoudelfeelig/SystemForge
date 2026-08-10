import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import {
  NotFoundPage,
  RouteErrorBoundary,
  RouteLoadingState,
} from "./components/RouteStatePage";
import { LandingPage } from "./pages/LandingPage";
import { RouteMetadata } from "./components/RouteMetadata";

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
const ReplayPage = lazy(() =>
  import("./pages/ReplayPage").then((module) => ({
    default: module.ReplayPage,
  })),
);
const DecisionPage = lazy(() =>
  import("./pages/DecisionPage").then((module) => ({
    default: module.DecisionPage,
  })),
);

export function App() {
  return (
    <RouteErrorBoundary>
      <Suspense fallback={<RouteLoadingState />}>
        <RouteMetadata />
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/lab" element={<LabPage />} />
          <Route
            path="/custom"
            element={<ScenarioDesignerPage key="custom" mode="custom" />}
          />
          <Route
            path="/interview"
            element={<ScenarioDesignerPage key="interview" mode="interview" />}
          />
          <Route path="/scenario/:id" element={<SharedScenarioPage />} />
          <Route path="/replay" element={<ReplayPage />} />
          <Route path="/decisions" element={<DecisionPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </RouteErrorBoundary>
  );
}
