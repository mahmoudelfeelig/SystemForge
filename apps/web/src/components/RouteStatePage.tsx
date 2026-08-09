import {
  ArrowLeft,
  ArrowRight,
  Check,
  CloudSlash,
  SpinnerGap,
  Warning,
} from "@phosphor-icons/react";
import { Component, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";
import { BrandIcon } from "./BrandIcon";

interface RouteStatePageProps {
  state: "loading" | "error" | "not-found";
  variant?: "workspace" | "shared" | "not-found";
  label: string;
  title: string;
  body: string;
  context?: string;
  retry?: { label: string; onClick: () => void };
  primary?: { label: string; to: string };
  secondary?: { label: string; to: string };
}

export function RouteStatePage({
  state,
  variant = "workspace",
  label,
  title,
  body,
  context,
  retry,
  primary,
  secondary,
}: RouteStatePageProps) {
  const StateIcon =
    state === "loading" ? SpinnerGap : state === "error" ? CloudSlash : Warning;
  const stages =
    variant === "shared"
      ? [
          "Open SystemForge",
          "Resolve shared route",
          "Load scenario",
          "Open Lab",
        ]
      : variant === "not-found"
        ? ["Open SystemForge", "Match requested route", "Choose a workspace"]
        : [
            "Open SystemForge",
            "Load application shell",
            "Restore local draft",
            "Prepare model worker",
          ];
  const boundary =
    variant === "shared"
      ? {
          label: "PRIVACY BOUNDARY",
          title: "Role data stays separated",
          context:
            context ??
            "No private scenario data is shown while this shared route is resolving.",
          facts: [
            ["Local runs", "Available"],
            ["Account", "Not required"],
            ["Shared link", state === "error" ? "Unavailable" : "Resolving"],
          ],
        }
      : variant === "not-found"
        ? {
            label: "WORKSPACES",
            title: "Choose where to continue",
            context:
              context ?? "The address does not match a SystemForge workspace.",
            facts: [
              ["Lab", "Build and run"],
              ["Scenarios", "Define a test"],
              ["Interviews", "Prepare a brief"],
              ["Replay", "Open a run"],
            ],
          }
        : {
            label: "RUNTIME BOUNDARY",
            title: "Preparing local tools",
            context:
              context ??
              "The application shell and browser-local model are loading. No short-link request is in progress.",
            facts: [
              ["Local draft", "Restoring"],
              ["Account", "Not required"],
              ["Short links", "Not requested"],
            ],
          };
  return (
    <div className={`route-console route-console--${variant}`}>
      <header className="route-console__header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <BrandIcon />
          <strong>SystemForge Lab</strong>
          <small>Connection console</small>
        </Link>
        <span className={`route-console__state route-console__state--${state}`}>
          <i />{" "}
          {state === "loading"
            ? "Connecting"
            : state === "error"
              ? "Connection failed"
              : "Route unavailable"}
        </span>
      </header>
      <main className="route-console__body">
        <aside className="route-console__rail" aria-label="Connection stages">
          <span className="panel-index">TRANSFER STATUS</span>
          <ol>
            {stages.map((stage, index) => (
              <li
                className={
                  index === 0
                    ? "complete"
                    : index === 1
                      ? state === "loading"
                        ? "active"
                        : "failed"
                      : "idle"
                }
                key={stage}
              >
                {index === 0 ? (
                  <Check size={13} />
                ) : index === 1 ? (
                  state === "loading" ? (
                    <SpinnerGap className="spin" size={13} />
                  ) : (
                    <Warning size={13} />
                  )
                ) : (
                  <span>{String(index + 1).padStart(2, "0")}</span>
                )}
                {stage}
              </li>
            ))}
          </ol>
          <Link to="/">
            <ArrowLeft size={14} /> Return home
          </Link>
        </aside>
        <section
          className={`route-console__message route-console__message--${state}`}
          aria-live={state === "loading" ? "polite" : "assertive"}
        >
          <span className="panel-index">{label}</span>
          <StateIcon
            className={state === "loading" ? "spin" : undefined}
            size={34}
            weight="duotone"
          />
          <h1>{title}</h1>
          <p>{body}</p>
          {retry || primary || secondary ? (
            <div>
              {retry ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={retry.onClick}
                >
                  {retry.label}
                  <ArrowRight size={15} />
                </button>
              ) : null}
              {primary ? (
                <Link
                  className={`button ${retry ? "" : "button--primary"}`}
                  to={primary.to}
                >
                  {primary.label}
                  <ArrowRight size={15} />
                </Link>
              ) : null}
              {secondary ? (
                <Link className="button" to={secondary.to}>
                  {secondary.label}
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>
        <aside className="route-console__boundary">
          <span className="panel-index">{boundary.label}</span>
          <strong>{boundary.title}</strong>
          <p>{boundary.context}</p>
          <dl>
            {boundary.facts.map(([term, description]) => (
              <div key={term}>
                <dt>{term}</dt>
                <dd>{description}</dd>
              </div>
            ))}
          </dl>
          {variant === "not-found" ? (
            <nav aria-label="Available SystemForge workspaces">
              <Link to="/lab">
                Open Lab <ArrowRight size={14} />
              </Link>
              <Link to="/custom">
                Scenario editor <ArrowRight size={14} />
              </Link>
              <Link to="/interview">
                Interview setup <ArrowRight size={14} />
              </Link>
              <Link to="/replay">
                Replay console <ArrowRight size={14} />
              </Link>
            </nav>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

export function RouteLoadingState() {
  return (
    <RouteStatePage
      state="loading"
      label="LOADING WORKSPACE"
      title="Opening the Lab"
      body="Loading the interface and local engine."
    />
  );
}

export function NotFoundPage() {
  return (
    <RouteStatePage
      state="not-found"
      variant="not-found"
      label="ROUTE NOT FOUND"
      title="No workspace at this address"
      body="Check the URL, or open a workspace below."
      primary={{ label: "Open Lab", to: "/lab" }}
      secondary={{ label: "Go home", to: "/" }}
    />
  );
}

interface RouteRenderBoundaryProps {
  children: ReactNode;
}

interface RouteRenderBoundaryState {
  failed: boolean;
}

class RouteRenderBoundary extends Component<
  RouteRenderBoundaryProps,
  RouteRenderBoundaryState
> {
  override state: RouteRenderBoundaryState = { failed: false };

  static getDerivedStateFromError(): RouteRenderBoundaryState {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <RouteStatePage
        state="error"
        label="WORKSPACE ERROR"
        title="This workspace could not open"
        body="Retry the workspace, or continue in the local Lab. Your saved browser draft has not been removed."
        retry={{
          label: "Retry",
          onClick: () => this.setState({ failed: false }),
        }}
        primary={{ label: "Open Lab", to: "/lab" }}
        secondary={{ label: "Home", to: "/" }}
      />
    );
  }
}

export function RouteErrorBoundary({ children }: RouteRenderBoundaryProps) {
  const location = useLocation();
  return (
    <RouteRenderBoundary key={`${location.pathname}${location.search}`}>
      {children}
    </RouteRenderBoundary>
  );
}
