import {
  ArrowRight,
  Broadcast,
  CloudSlash,
  Compass,
  GitBranch,
  ShareNetwork,
  TerminalWindow,
} from "@phosphor-icons/react";
import { Link } from "react-router-dom";

export function LandingPage() {
  return (
    <div className="site-shell">
      <header className="site-header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <span>SF</span>
          <strong>SystemForge</strong>
        </Link>
        <nav aria-label="Primary navigation">
          <a href="#method">Method</a>
          <Link to="/custom">Custom challenge</Link>
          <Link to="/interview">Interview mode</Link>
        </nav>
        <Link className="button button--primary" to="/lab">
          Open the lab <ArrowRight size={16} />
        </Link>
      </header>
      <main>
        <section className="hero">
          <div className="hero__copy">
            <span className="eyebrow">
              <Broadcast size={16} weight="duotone" /> Distributed systems,
              under pressure
            </span>
            <h1>Build systems that fail for reasons.</h1>
            <p>
              Design an architecture, send realistic traffic through it, inject
              incidents and trace the causal chain from the first fault to the
              final retry storm.
            </p>
            <div className="hero__actions">
              <Link className="button button--primary" to="/lab">
                Run Black Friday Checkout <ArrowRight size={17} />
              </Link>
              <Link className="button" to="/custom">
                Design a requirement set
              </Link>
            </div>
            <div className="local-guarantee">
              <CloudSlash size={18} weight="duotone" />
              <div>
                <strong>The lab runs locally.</strong>
                <span>
                  Outages and capacity limits can stop canonical submission, not
                  your browser simulation.
                </span>
              </div>
            </div>
          </div>
          <div
            className="hero-console"
            aria-label="SystemForge mission control preview"
          >
            <header>
              <span>Mission Control</span>
              <strong>Black Friday Checkout</strong>
              <b>Running</b>
            </header>
            <div className="hero-console__canvas">
              <div
                className="preview-node healthy"
                style={{ left: "6%", top: "43%" }}
              >
                <span>Users</span>
                <strong>74.3k/s</strong>
              </div>
              <div
                className="preview-node healthy"
                style={{ left: "28%", top: "43%" }}
              >
                <span>Load Balancer</span>
                <strong>71%</strong>
              </div>
              <div
                className="preview-node warning"
                style={{ left: "50%", top: "43%" }}
              >
                <span>API Gateway</span>
                <strong>81%</strong>
              </div>
              <div
                className="preview-node critical"
                style={{ left: "68%", top: "17%" }}
              >
                <span>Redis Cluster</span>
                <strong>Unavailable</strong>
              </div>
              <div
                className="preview-node critical"
                style={{ left: "75%", top: "62%" }}
              >
                <span>PostgreSQL</span>
                <strong>97%</strong>
              </div>
            </div>
            <footer>
              <span>13:04 Cache failure</span>
              <span>DB load +281%</span>
              <span>Retry storm</span>
            </footer>
          </div>
        </section>
        <section className="mode-rail" id="method">
          <article>
            <Compass size={22} weight="duotone" />
            <div>
              <span>Guided</span>
              <h2>Learn through a known pressure test.</h2>
              <p>
                Visible requirements, engineered incidents and causal
                explanations.
              </p>
            </div>
            <Link to="/lab" aria-label="Open guided lab">
              <ArrowRight size={18} />
            </Link>
          </article>
          <article>
            <GitBranch size={22} weight="duotone" />
            <div>
              <span>Custom</span>
              <h2>Author the problem, not the answer.</h2>
              <p>
                Define workloads, constraints and incidents, then share the
                challenge.
              </p>
            </div>
            <Link to="/custom" aria-label="Create custom challenge">
              <ArrowRight size={18} />
            </Link>
          </article>
          <article>
            <TerminalWindow size={22} weight="duotone" />
            <div>
              <span>Interview</span>
              <h2>Let candidates derive the requirements.</h2>
              <p>
                Separate interviewer criteria from the candidate brief and
                inferred constraints.
              </p>
            </div>
            <Link to="/interview" aria-label="Create interview">
              <ArrowRight size={18} />
            </Link>
          </article>
        </section>
        <section className="method-statement">
          <ShareNetwork size={28} weight="duotone" />
          <div>
            <span>One deterministic run manifest</span>
            <h2>
              The same seed, architecture and model version reconstruct the same
              event chain.
            </h2>
          </div>
        </section>
      </main>
      <footer className="site-footer">
        <span>SystemForge</span>
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
