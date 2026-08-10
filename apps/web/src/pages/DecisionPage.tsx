import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { DecisionWorkbenchBoundary } from "../components/DecisionWorkbenchBoundary";

export function DecisionPage() {
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate("/lab");
  }, [navigate]);

  return (
    <main className="decision-page" aria-label="Decision workbench workspace">
      <h1 className="visually-hidden">Decision workbench</h1>
      <DecisionWorkbenchBoundary open onClose={close} />
    </main>
  );
}
