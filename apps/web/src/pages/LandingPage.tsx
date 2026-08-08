import {
  ArrowRight,
  Broadcast,
  CheckCircle,
  CloudSlash,
  Compass,
  Database,
  GitBranch,
  Pulse,
  ShareNetwork,
  TerminalWindow,
  WarningOctagon,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";

const objectives = [
  ["p95 latency", "<= 400 ms", "386 ms", "warning"],
  ["Availability", ">= 99.99%", "99.94%", "critical"],
  ["Confirmed loss", "= 0", "0", "healthy"],
  ["Monthly cost", "<= EUR 140k", "EUR 128k", "healthy"],
] as const;

export function LandingPage() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <span>SF</span>
          <strong>SystemForge</strong>
          <small>Distributed systems laboratory</small>
        </Link>
        <nav aria-label="Primary navigation">
          <a href="#operating-modes">Operating modes</a>
          <Link to="/custom">Challenge studio</Link>
          <Link to="/interview">Interview studio</Link>
        </nav>
        <Link className="button button--primary" to="/lab">
          Enter mission control <ArrowRight size={16} />
        </Link>
      </header>

      <main className="landing-main">
        <section className="mission-brief" aria-labelledby="mission-title">
          <aside className="mission-dossier">
            <span className="panel-index">SYS / 01 / MISSION DOSSIER</span>
            <div className="mission-dossier__status">
              <Broadcast size={15} weight="fill" /> LIVE SYSTEM EXERCISE
            </div>
            <h1 id="mission-title">
              Architecture is a hypothesis. <em>Break it.</em>
            </h1>
            <p>
              Assemble behavioral primitives, drive realistic demand through
              them, then follow every failure through the system it changes.
            </p>
            <div className="mission-dossier__actions">
              <Link className="button button--primary" to="/lab">
                Run Black Friday Checkout <ArrowRight size={17} />
              </Link>
              <Link className="text-action" to="/custom">
                Author another mission <ArrowRight size={15} />
              </Link>
            </div>
            <dl className="mission-facts">
              <div>
                <dt>Engine</dt>
                <dd>Deterministic hybrid simulation</dd>
              </div>
              <div>
                <dt>Failure vocabulary</dt>
                <dd>35 incident types</dd>
              </div>
              <div>
                <dt>Evidence</dt>
                <dd>Resource traces + causal graph</dd>
              </div>
            </dl>
          </aside>

          <div className="mission-stage" aria-label="Active mission preview">
            <header className="mission-stage__header">
              <div>
                <span className="panel-index">SYS / 02 / ACTIVE TOPOLOGY</span>
                <strong>Black Friday Checkout</strong>
              </div>
              <div className="mission-clock">
                <span>RUN 819521</span>
                <time>01:04 / 02:00</time>
                <b>UNDER PRESSURE</b>
              </div>
            </header>

            <div className="mission-stage__body">
              <div className="topology-preview">
                <div className="topology-lane" aria-label="Request path">
                  <article className="topology-node topology-node--healthy">
                    <span>01 / EDGE</span>
                    <strong>Global CDN</strong>
                    <small>112k req/s · 18% hit</small>
                  </article>
                  <ArrowRight size={18} aria-hidden="true" />
                  <article className="topology-node topology-node--warning">
                    <span>02 / COMPUTE</span>
                    <strong>API Gateway</strong>
                    <small>81% CPU · scaling +8</small>
                  </article>
                  <ArrowRight size={18} aria-hidden="true" />
                  <article className="topology-node topology-node--critical">
                    <span>03 / STATE</span>
                    <strong>Redis Cluster</strong>
                    <small>OFFLINE · failover pending</small>
                  </article>
                </div>
                <div className="topology-branch">
                  <span>DOWNSTREAM PRESSURE</span>
                  <article className="topology-node topology-node--critical">
                    <Database size={18} weight="duotone" />
                    <div>
                      <strong>PostgreSQL Primary</strong>
                      <small>97% IOPS · 2.8s replica lag</small>
                    </div>
                  </article>
                  <article className="topology-node topology-node--warning">
                    <Pulse size={18} weight="duotone" />
                    <div>
                      <strong>Order Queue</strong>
                      <small>28,416 waiting · oldest 9.2s</small>
                    </div>
                  </article>
                </div>
              </div>

              <aside className="objective-ledger">
                <header>
                  <span className="panel-index">OBJECTIVE LEDGER</span>
                  <strong>2 / 4 holding</strong>
                </header>
                {objectives.map(([label, target, actual, state], index) => (
                  <div
                    className={`objective-row objective-row--${state}`}
                    key={label}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <strong>{label}</strong>
                      <small>{target}</small>
                    </div>
                    <b>{actual}</b>
                    {state === "critical" ? (
                      <WarningOctagon size={15} weight="fill" />
                    ) : (
                      <CheckCircle size={15} weight="fill" />
                    )}
                  </div>
                ))}
              </aside>
            </div>

            <footer className="causal-preview">
              <span className="panel-index">CAUSAL SIGNAL / SELECTED</span>
              <ol>
                <li>
                  <b>01:04</b> Cache node unavailable
                </li>
                <li>
                  <b>+0.2s</b> Cache hit rate collapses
                </li>
                <li>
                  <b>+0.8s</b> Database read load +281%
                </li>
                <li>
                  <b>+1.4s</b> Client timeouts trigger retries
                </li>
              </ol>
            </footer>
          </div>
        </section>

        <section className="local-guarantee">
          <CloudSlash size={20} weight="duotone" />
          <div>
            <strong>Local-first by design</strong>
            <span>
              The deterministic engine runs in your browser. Server capacity
              only affects canonical storage and short links.
            </span>
          </div>
          <span>NO LOGIN · NO QUEUE · REPRODUCIBLE SEED</span>
        </section>

        <section className="operating-modes" id="operating-modes">
          <header className="section-heading">
            <span className="panel-index">SYS / 03 / OPERATING MODES</span>
            <h2>Change the brief. Keep the physics.</h2>
            <p>
              Every mode compiles to the same scenario, architecture, incident,
              and evidence contracts. Only the information boundary changes.
            </p>
          </header>
          <div className="mode-rail">
            <article>
              <span>01</span>
              <Compass size={21} weight="duotone" />
              <div>
                <small>GUIDED MISSION</small>
                <h3>Pressure-test a known system problem.</h3>
                <p>
                  Visible objectives, scheduled incidents, full causal
                  explanations.
                </p>
              </div>
              <Link to="/lab" aria-label="Open guided lab">
                <ArrowRight size={18} />
              </Link>
            </article>
            <article>
              <span>02</span>
              <GitBranch size={21} weight="duotone" />
              <div>
                <small>CHALLENGE STUDIO</small>
                <h3>Author requirements and trade-offs.</h3>
                <p>
                  Workload mix, regional demand, failure schedule, and domain
                  invariants.
                </p>
              </div>
              <Link to="/custom" aria-label="Create custom challenge">
                <ArrowRight size={18} />
              </Link>
            </article>
            <article>
              <span>03</span>
              <TerminalWindow size={21} weight="duotone" />
              <div>
                <small>INTERVIEW STUDIO</small>
                <h3>Test discovery, not memorization.</h3>
                <p>
                  Private evaluation criteria, candidate-derived constraints,
                  controlled reveals.
                </p>
              </div>
              <Link to="/interview" aria-label="Create interview">
                <ArrowRight size={18} />
              </Link>
            </article>
          </div>
        </section>

        <section className="method-statement">
          <ShareNetwork size={27} weight="duotone" />
          <span className="panel-index">THE REPRODUCIBILITY CONTRACT</span>
          <h2>Same seed. Same architecture. Same event chain.</h2>
          <p>
            A run manifest records the model version and every input required to
            reconstruct the result. You can argue about the design without
            arguing about what happened.
          </p>
          <Link className="text-action" to="/lab">
            Inspect the current mission <ArrowRight size={15} />
          </Link>
        </section>
      </main>

      <footer className="site-footer">
        <span>SystemForge / Distributed systems laboratory</span>
        <a
          href="https://github.com/mahmoudelfeelig/SystemForge"
          target="_blank"
          rel="noreferrer"
        >
          AGPL-3.0 · View source
        </a>
      </footer>
    </div>
  );
}
