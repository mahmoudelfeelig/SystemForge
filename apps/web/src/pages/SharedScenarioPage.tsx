import { ArrowLeft, CloudSlash, SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { fetchSharedScenario } from "../lib/api";
import { useLabStore } from "../store/useLabStore";

export function SharedScenarioPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const loadSharedScenario = useLabStore((state) => state.loadSharedScenario);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) {
      setError("This scenario link is missing its identifier.");
      return;
    }
    const controller = new AbortController();
    void fetchSharedScenario(id, searchParams.get("hostToken") ?? undefined)
      .then((shared) => {
        if (controller.signal.aborted) return;
        loadSharedScenario(shared.scenario, shared.architecture, shared.role);
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
  }, [id, loadSharedScenario, navigate, searchParams]);

  return (
    <main className="share-loader">
      <Link to="/">
        <ArrowLeft size={17} /> SystemForge
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
