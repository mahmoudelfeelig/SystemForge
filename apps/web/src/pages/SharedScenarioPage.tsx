import { ArrowLeft, CloudSlash, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { fetchSharedScenario } from "../lib/api";
import { useLabStore } from "../store/useLabStore";
import { BrandIcon } from "../components/BrandIcon";

export function SharedScenarioPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const loadSharedScenario = useLabStore((state) => state.loadSharedScenario);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("This scenario link is missing its identifier.");
      return;
    }
    const controller = new AbortController();
    const hostToken = new URLSearchParams(window.location.hash.slice(1)).get(
      "hostToken",
    );
    void fetchSharedScenario(id, hostToken ?? undefined)
      .then((shared) => {
        if (controller.signal.aborted) return;
        loadSharedScenario(shared.scenario, shared.architecture, shared.role, {
          id: shared.id,
          ...(hostToken ? { hostToken } : {}),
          revealState: shared.revealState,
        });
        void navigate("/lab", { replace: true });
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(
          reason instanceof Error
            ? reason.message
            : "This shared scenario could not be loaded.",
        );
      });
    return () => controller.abort();
  }, [id, loadSharedScenario, navigate]);

  return (
    <main className="share-loader">
      <Link to="/">
        <ArrowLeft size={17} /> <BrandIcon /> SystemForge
      </Link>
      {error ? (
        <section>
          <CloudSlash size={34} />
          <h1>Canonical sharing is unavailable.</h1>
          <p>
            {error} You can still open SystemForge and use browser-local
            challenges and simulations.
          </p>
          <Link className="button button--primary" to="/lab">
            Continue locally
          </Link>
        </section>
      ) : (
        <section>
          <SpinnerGap className="spin" size={34} />
          <h1>Loading the shared challenge</h1>
          <p>
            Private interviewer criteria are only requested when the link
            includes its host credential.
          </p>
        </section>
      )}
    </main>
  );
}
