import {
  ArrowRight,
  Broadcast,
  CheckCircle,
  Compass,
  Database,
  EnvelopeSimple,
  GithubLogo,
  GitBranch,
  HardDrives,
  LinkedinLogo,
  Pulse,
  TerminalWindow,
  WarningOctagon,
} from "@phosphor-icons/react";
import {
  DEFAULT_ARCHITECTURE,
  DEFAULT_SCENARIO,
  simulate,
} from "@systemforge/sim-core";
import { Link } from "react-router-dom";
import { BrandIcon } from "../components/BrandIcon";

const previewResult = simulate(DEFAULT_SCENARIO, DEFAULT_ARCHITECTURE, {
  includeTraces: false,
});
const previewFrame = previewResult.frames.find((frame) => frame.second === 64)!;
const previewObjectives = previewResult.requirements.slice(0, 4);
const previewPassed = previewObjectives.filter(
  (result) => result.passed,
).length;

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const formatRequirementValue = (value: number, unit: string): string => {
  const rendered = value.toLocaleString("en-US", {
    maximumFractionDigits: unit === "%" ? 3 : 1,
  });
  return unit === "EUR"
    ? "EUR " + rendered
    : rendered + (unit ? " " + unit : "");
};

const requirementTarget = (
  operator: "lte" | "gte" | "eq",
  target: number,
  unit: string,
): string =>
  (operator === "lte"
    ? "at most "
    : operator === "gte"
      ? "at least "
      : "exactly ") + formatRequirementValue(target, unit);

const operatingModes = [
  {
    index: "01",
    label: "Failure lab",
    title: "Start with a complete system",
    detail:
      "Open the checkout architecture, run its failure schedule, and inspect what breaks.",
    to: "/lab",
    icon: Compass,
  },
  {
    index: "02",
    label: "Scenario editor",
    title: "Define workload and failure conditions",
    detail:
      "Set traffic, regions, incidents, and the thresholds a run must meet.",
    to: "/custom",
    icon: GitBranch,
  },
  {
    index: "03",
    label: "Interview room",
    title: "Keep the rubric private",
    detail:
      "Share the problem with candidates while the scorecard stays with the interviewer.",
    to: "/interview",
    icon: TerminalWindow,
  },
  {
    index: "04",
    label: "Replay console",
    title: "Verify and compare completed runs",
    detail:
      "Open a replay bundle, verify its internal checks, and recompute both branches locally.",
    to: "/replay",
    icon: HardDrives,
  },
] as const;

export function LandingPage() {
  return (
    <div className="site-shell site-shell--console">
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <BrandIcon />
          <strong>SystemForge Lab</strong>
          <small>Distributed systems lab</small>
        </Link>
        <nav aria-label="Primary navigation">
          <Link to="/lab">Lab</Link>
          <Link to="/custom">Scenarios</Link>
          <Link to="/interview">Interviews</Link>
          <Link to="/replay">Replays</Link>
        </nav>
        <div className="site-header__runtime">
          <Link className="button button--primary" to="/lab">
            Open the lab <ArrowRight size={16} />
          </Link>
        </div>
      </header>

      <main className="landing-main landing-main--console">
        <section className="home-console" aria-labelledby="home-title">
          <aside className="home-console__rail">
            <header>
              <span className="panel-index">Start here</span>
              <div className="home-console__status">
                <Broadcast size={14} weight="fill" /> Runs in this browser
              </div>
              <h1 id="home-title">
                Build and test distributed systems in your browser.
              </h1>
              <p>
                Wire the topology, set the workload, inject a failure, and
                follow the bottleneck through the graph.
              </p>
            </header>

            <div className="home-console__actions">
              <Link className="button button--primary" to="/lab">
                Run the checkout scenario <ArrowRight size={16} />
              </Link>
              <Link className="text-action" to="/custom">
                Define a new scenario <ArrowRight size={14} />
              </Link>
            </div>

            <div
              className="home-console__mode-list"
              aria-label="Available workflows"
            >
              {operatingModes.map((mode) => {
                const Icon = mode.icon;
                return (
                  <Link to={mode.to} key={mode.index}>
                    <span>{mode.index}</span>
                    <Icon size={16} weight="duotone" />
                    <div>
                      <small>{mode.label}</small>
                      <strong>{mode.title}</strong>
                    </div>
                    <ArrowRight size={14} />
                  </Link>
                );
              })}
            </div>

            <dl className="home-console__facts">
              <div>
                <dt>Timeline</dt>
                <dd>One-second simulation</dd>
              </div>
              <div>
                <dt>Failures</dt>
                <dd>35 scheduled incident types</dd>
              </div>
              <div>
                <dt>Replay</dt>
                <dd>Captured inputs and actions</dd>
              </div>
            </dl>
          </aside>

          <div
            className="home-console__workspace"
            aria-label="Black Friday Checkout preview"
          >
            <header className="home-workspace__bar">
              <div>
                <span className="panel-index">
                  Engine {previewResult.engineVersion} modeled frame
                </span>
                <strong>Black Friday Checkout</strong>
              </div>
              <dl>
                <div>
                  <dt>Frame</dt>
                  <dd className="status-critical">Failure active</dd>
                </div>
                <div>
                  <dt>Time</dt>
                  <dd>01:04 / 02:00</dd>
                </div>
                <div>
                  <dt>Seed</dt>
                  <dd>{previewResult.seed}</dd>
                </div>
              </dl>
            </header>

            <div className="home-workspace__main">
              <section
                className="home-topology"
                aria-labelledby="topology-title"
              >
                <header>
                  <div>
                    <span className="panel-index">System topology</span>
                    <h2 id="topology-title">Checkout request path</h2>
                  </div>
                  <span>
                    <Pulse size={14} /> Previewed dependency path
                  </span>
                </header>

                <div className="topology-preview topology-preview--console">
                  <div className="topology-lane" aria-label="Topology preview">
                    <article className="topology-node topology-node--healthy">
                      <span>EDGE</span>
                      <strong>Global CDN</strong>
                      <small>
                        {compact.format(
                          previewFrame.nodeMetrics.cdn?.admittedRps ?? 0,
                        )}{" "}
                        admitted ·{" "}
                        {Math.round(
                          previewFrame.nodeMetrics.cdn?.admissionPercent ?? 0,
                        )}
                        % admission
                      </small>
                    </article>
                    <ArrowRight size={18} aria-hidden="true" />
                    <article className="topology-node topology-node--warning">
                      <span>COMPUTE</span>
                      <strong>API Gateway</strong>
                      <small>
                        {Math.round(
                          (previewFrame.nodeMetrics.api?.cpuUtilization ?? 0) *
                            100,
                        )}
                        % CPU · {previewFrame.nodeMetrics.api?.activeInstances}{" "}
                        instances
                      </small>
                    </article>
                    <ArrowRight size={18} aria-hidden="true" />
                    <article className="topology-node topology-node--critical">
                      <span>STATE</span>
                      <strong>Redis Cluster</strong>
                      <small>
                        {previewFrame.nodeMetrics.cache?.state ?? "unknown"} ·{" "}
                        {Math.round(
                          previewFrame.nodeMetrics.cache?.errorRate ?? 0,
                        )}
                        % error
                      </small>
                    </article>
                  </div>
                  <div className="topology-branch">
                    <span>DOWNSTREAM LOAD</span>
                    <article className="topology-node topology-node--critical">
                      <Database size={18} weight="duotone" />
                      <div>
                        <strong>PostgreSQL Primary</strong>
                        <small>
                          {Math.round(
                            (previewFrame.nodeMetrics.db?.iopsUtilization ??
                              0) * 100,
                          )}
                          % IOPS ·{" "}
                          {Math.round(
                            previewFrame.nodeMetrics.db?.replicaLagMs ?? 0,
                          )}
                          ms replica lag
                        </small>
                      </div>
                    </article>
                    <article className="topology-node topology-node--warning">
                      <HardDrives size={18} weight="duotone" />
                      <div>
                        <strong>Order Queue</strong>
                        <small>
                          {Math.round(
                            previewFrame.nodeMetrics.queue?.queueDepth ?? 0,
                          ).toLocaleString("en-US")}{" "}
                          queued · oldest {previewFrame.maxQueueAgeMs / 1_000}s
                        </small>
                      </div>
                    </article>
                  </div>
                </div>
              </section>

              <aside
                className="objective-ledger"
                aria-labelledby="objectives-title"
              >
                <header>
                  <span className="panel-index">Run targets</span>
                  <strong id="objectives-title">
                    {previewPassed} of {previewObjectives.length} pass
                  </strong>
                </header>
                {previewObjectives.map((result, index) => (
                  <div
                    className={`objective-row objective-row--${result.passed ? "healthy" : "critical"}`}
                    key={result.requirement.id}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{result.requirement.label}</strong>
                      <small>
                        {requirementTarget(
                          result.requirement.operator,
                          result.requirement.target,
                          result.requirement.unit,
                        )}
                      </small>
                    </div>
                    <b>
                      {formatRequirementValue(
                        result.actual,
                        result.requirement.unit,
                      )}
                    </b>
                    {!result.passed ? (
                      <WarningOctagon size={15} weight="fill" />
                    ) : (
                      <CheckCircle size={15} weight="fill" />
                    )}
                    <span className="visually-hidden">
                      {result.passed ? "Passing" : "Failed"}
                    </span>
                  </div>
                ))}
              </aside>
            </div>

            <details className="home-diagnostics-disclosure">
              <summary>
                <span>
                  <strong>Explore the modeled failure</strong>
                  <small>
                    Events, live signals, and the causal explanation
                  </small>
                </span>
                <ArrowRight size={16} />
              </summary>
              <div className="home-workspace__diagnostics">
                <section className="home-events" aria-labelledby="events-title">
                  <header>
                    <span className="panel-index">Events</span>
                    <strong id="events-title">Preview event chain</strong>
                  </header>
                  <ol>
                    <li>
                      <time>01:04.0</time>
                      <i className="critical" aria-hidden="true" />
                      <span className="visually-hidden">Critical: </span>
                      Redis node unavailable
                    </li>
                    <li>
                      <time>01:04.2</time>
                      <i className="warning" aria-hidden="true" />
                      <span className="visually-hidden">Warning: </span>
                      Cache hit rate drops
                    </li>
                    <li>
                      <time>01:04.8</time>
                      <i className="critical" aria-hidden="true" />
                      <span className="visually-hidden">Critical: </span>
                      Database read load +281%
                    </li>
                    <li>
                      <time>01:05.4</time>
                      <i className="critical" aria-hidden="true" />
                      <span className="visually-hidden">Critical: </span>
                      Client retries increase
                    </li>
                  </ol>
                </section>
                <section
                  className="home-signals"
                  aria-labelledby="signals-title"
                >
                  <header>
                    <span className="panel-index">Current signals</span>
                    <strong id="signals-title">Resource pressure</strong>
                  </header>
                  <dl>
                    <div>
                      <dt>API CPU</dt>
                      <dd>
                        <progress
                          max="100"
                          value="81"
                          aria-label="API CPU utilization: 81 percent"
                        />
                        81%
                      </dd>
                    </div>
                    <div>
                      <dt>Database IOPS</dt>
                      <dd>
                        <progress
                          max="100"
                          value="97"
                          aria-label="Database IOPS utilization: 97 percent"
                        />
                        97%
                      </dd>
                    </div>
                    <div>
                      <dt>Queue utilization</dt>
                      <dd>
                        <progress
                          max="100"
                          value="76"
                          aria-label="Queue utilization: 76 percent"
                        />
                        76%
                      </dd>
                    </div>
                    <div>
                      <dt>Availability</dt>
                      <dd>
                        <progress
                          max="100"
                          value="99.94"
                          aria-label="Availability: 99.94 percent"
                        />
                        99.94%
                      </dd>
                    </div>
                  </dl>
                </section>
                <section
                  className="home-root-cause"
                  aria-labelledby="cause-title"
                >
                  <span className="panel-index">Why it failed</span>
                  <Database size={20} weight="duotone" />
                  <div>
                    <h2 id="cause-title">
                      Cache loss shifted reads to PostgreSQL
                    </h2>
                    <p>
                      In this preview, database saturation raises latency and
                      drives more client retries.
                    </p>
                  </div>
                  <Link to="/lab">
                    Inspect the run <ArrowRight size={14} />
                  </Link>
                </section>
              </div>
            </details>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <a className="site-footer__brand" href="https://elfeel.me">
          <BrandIcon />
          <span>
            <strong>SystemForge</strong>
            <small>A Mahmoud Elfeel project</small>
          </span>
        </a>
        <p className="site-footer__note">
          Test designs, failures, and tradeoffs before they reach production.
        </p>
        <nav className="site-footer__reachability" aria-label="Contact links">
          <a
            href="mailto:mahmoudelfeelig@gmail.com"
            aria-label="Email Mahmoud Elfeel"
            title="Email"
          >
            <EnvelopeSimple size={19} weight="duotone" />
            <span className="visually-hidden">Email</span>
          </a>
          <a
            href="https://www.linkedin.com/in/elephanto"
            target="_blank"
            rel="noreferrer"
            aria-label="Mahmoud Elfeel on LinkedIn"
            title="LinkedIn"
          >
            <LinkedinLogo size={19} weight="duotone" />
            <span className="visually-hidden">LinkedIn</span>
          </a>
          <a
            href="https://github.com/mahmoudelfeelig/SystemForge"
            target="_blank"
            rel="noreferrer"
            aria-label="SystemForge on GitHub"
            title="GitHub"
          >
            <GithubLogo size={19} weight="duotone" />
            <span className="visually-hidden">GitHub</span>
          </a>
        </nav>
      </footer>
    </div>
  );
}
