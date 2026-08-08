import {
  ArrowClockwise,
  ArrowCounterClockwise,
  BookmarkSimple,
  Books,
  CheckCircle,
  DownloadSimple,
  FileText,
  Flask,
  GitBranch,
  Lock,
  Printer,
  Scales,
  Sparkle,
  Timer,
  Trash,
  UploadSimple,
  UsersThree,
  Warning,
  X,
} from "@phosphor-icons/react";
import {
  SOLVER_STRATEGIES,
  analyzeRobustness,
  type RobustnessResult,
  type SolverCandidate,
  type SolverStrategy,
} from "@systemforge/sim-core";
import { useEffect, useMemo, useRef, useState } from "react";
import { downloadEvidenceReport } from "../lib/evidenceReport";
import {
  applyProviderSku,
  parseProviderCatalog,
  type ProviderCatalog,
} from "../lib/providerCatalog";
import { SCENARIO_LIBRARY } from "../lib/scenarioLibrary";
import {
  applyTrafficProfile,
  parseTrafficProfile,
} from "../lib/trafficProfile";
import {
  applyTopologyProposal,
  proposeTopologyChanges,
} from "../lib/topologySynthesis";
import { useLabStore } from "../store/useLabStore";

type DecisionTab =
  "solve" | "history" | "missions" | "calibrate" | "session" | "report";

interface DecisionWorkbenchProps {
  open: boolean;
  onClose: () => void;
}

const tabs: Array<{
  id: DecisionTab;
  label: string;
  icon: typeof Scales;
}> = [
  { id: "solve", label: "Compare", icon: Scales },
  { id: "history", label: "Versions", icon: GitBranch },
  { id: "missions", label: "Missions", icon: Books },
  { id: "calibrate", label: "Calibrate", icon: Flask },
  { id: "session", label: "Session", icon: UsersThree },
  { id: "report", label: "Evidence", icon: FileText },
];

const strategyLabels: Record<SolverStrategy, string> = {
  "horizontal-scale": "Horizontal scale",
  "elastic-scale": "Elastic scaling",
  "resilience-controls": "Resilience controls",
  "durable-replication": "Durable replication",
  "storage-partitioning": "Storage partitioning",
  "cache-efficiency": "Cache efficiency",
  "consumer-parallelism": "Consumer parallelism",
};

const formatMetric = (value: number, unit = "") =>
  `${Number.isInteger(value) ? value.toLocaleString("en-US") : value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${unit}`;

const metricDeltaClass = (value: number, lowerIsBetter = false) => {
  if (Math.abs(value) < 0.000_001) return "neutral";
  return (lowerIsBetter ? value < 0 : value > 0) ? "positive" : "negative";
};

function CandidateRow({
  candidate,
  recommended,
  onInspect,
}: {
  candidate: SolverCandidate;
  recommended: boolean;
  onInspect: () => void;
}) {
  return (
    <button
      type="button"
      className={`candidate-row ${recommended ? "candidate-row--recommended" : ""}`}
      onClick={onInspect}
    >
      <span className="candidate-rank">
        {String(candidate.rank).padStart(2, "0")}
      </span>
      <span className="candidate-name">
        <strong>{candidate.label}</strong>
        <small>
          {candidate.changes.map((change) => change.title).join(" + ")}
        </small>
      </span>
      <span>
        {candidate.evaluation.metrics.requirementsPassed}/
        {candidate.evaluation.metrics.requirementsTotal}
      </span>
      <span className={metricDeltaClass(candidate.deltas.p95LatencyMs, true)}>
        {candidate.deltas.p95LatencyMs > 0 ? "+" : ""}
        {formatMetric(candidate.deltas.p95LatencyMs, " ms")}
      </span>
      <span className={metricDeltaClass(candidate.deltas.monthlyCostEur, true)}>
        {candidate.deltas.monthlyCostEur > 0 ? "+" : ""}
        {formatMetric(candidate.deltas.monthlyCostEur, " EUR")}
      </span>
      <span className="candidate-flags">
        {recommended ? <b>Recommended</b> : null}
        {candidate.paretoOptimal ? <i>Pareto</i> : null}
        {!candidate.eligible ? <em>Blocked</em> : null}
      </span>
    </button>
  );
}

export function DecisionWorkbench({ open, onClose }: DecisionWorkbenchProps) {
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const result = useLabStore((state) => state.result);
  const solverResult = useLabStore((state) => state.solverResult);
  const solverState = useLabStore((state) => state.solverState);
  const solverExecution = useLabStore((state) => state.solverExecution);
  const role = useLabStore((state) => state.role);
  const sharedScenarioId = useLabStore((state) => state.sharedScenarioId);
  const collaboration = useLabStore((state) => state.collaboration);
  const snapshots = useLabStore((state) => state.architectureSnapshots);
  const undoCount = useLabStore((state) => state.architectureUndo.length);
  const redoCount = useLabStore((state) => state.architectureRedo.length);
  const setScenario = useLabStore((state) => state.setScenario);
  const setArchitecture = useLabStore((state) => state.setArchitecture);
  const solveAlternatives = useLabStore((state) => state.solveAlternatives);
  const undoArchitecture = useLabStore((state) => state.undoArchitecture);
  const redoArchitecture = useLabStore((state) => state.redoArchitecture);
  const saveSnapshot = useLabStore((state) => state.saveArchitectureSnapshot);
  const restoreSnapshot = useLabStore(
    (state) => state.restoreArchitectureSnapshot,
  );
  const removeSnapshot = useLabStore(
    (state) => state.removeArchitectureSnapshot,
  );
  const updateCollaboration = useLabStore(
    (state) => state.updateInterviewCollaboration,
  );
  const dialogRef = useRef<HTMLDivElement>(null);
  const [tab, setTab] = useState<DecisionTab>("solve");
  const [maxCandidates, setMaxCandidates] = useState(16);
  const [maxChanges, setMaxChanges] = useState<1 | 2>(2);
  const [allowedStrategies, setAllowedStrategies] = useState<SolverStrategy[]>([
    ...SOLVER_STRATEGIES,
  ]);
  const [lockedNodeIds, setLockedNodeIds] = useState<string[]>([]);
  const [maximumCost, setMaximumCost] = useState("");
  const [maximumComplexity, setMaximumComplexity] = useState("");
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(
    null,
  );
  const [snapshotLabel, setSnapshotLabel] = useState("");
  const [profileText, setProfileText] = useState("");
  const [profileError, setProfileError] = useState<string | null>(null);
  const [catalogText, setCatalogText] = useState("");
  const [catalog, setCatalog] = useState<ProviderCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogNodeId, setCatalogNodeId] = useState(
    architecture.nodes[0]?.id ?? "",
  );
  const [catalogSku, setCatalogSku] = useState("");
  const [robustness, setRobustness] = useState<RobustnessResult | null>(null);
  const [robustnessError, setRobustnessError] = useState<string | null>(null);
  const [robustnessRunning, setRobustnessRunning] = useState(false);
  const [candidateNotes, setCandidateNotes] = useState(
    collaboration.candidateNotes,
  );
  const [interviewerNotes, setInterviewerNotes] = useState(
    collaboration.interviewerNotes ?? "",
  );
  const [candidateCursor, setCandidateCursor] = useState(
    collaboration.candidateCursor,
  );
  const [clockNow, setClockNow] = useState(Date.now());

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const first = dialogRef.current?.querySelector<HTMLElement>("button");
    first?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href]",
        ),
      );
      if (focusable.length === 0) return;
      const firstFocusable = focusable[0]!;
      const lastFocusable = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === firstFocusable) {
        event.preventDefault();
        lastFocusable.focus();
      } else if (!event.shiftKey && document.activeElement === lastFocusable) {
        event.preventDefault();
        firstFocusable.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);

  useEffect(() => {
    setCandidateNotes(collaboration.candidateNotes);
    setCandidateCursor(collaboration.candidateCursor);
    setInterviewerNotes(collaboration.interviewerNotes ?? "");
  }, [
    collaboration.updatedAt,
    collaboration.candidateNotes,
    collaboration.candidateCursor,
    collaboration.interviewerNotes,
  ]);

  useEffect(() => {
    if (scenario.mode !== "interview" && tab === "session") setTab("solve");
  }, [scenario.mode, tab]);

  useEffect(() => {
    if (!collaboration.startedAt) return;
    const timer = window.setInterval(() => setClockNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [collaboration.startedAt]);

  const selectedCandidate = useMemo(
    () =>
      solverResult?.candidates.find(
        (candidate) => candidate.id === selectedCandidateId,
      ) ??
      solverResult?.candidates.find(
        (candidate) => candidate.id === solverResult.recommendedCandidateId,
      ) ??
      solverResult?.candidates[0] ??
      null,
    [selectedCandidateId, solverResult],
  );
  const topologyProposals = useMemo(
    () => proposeTopologyChanges(scenario, architecture),
    [architecture, scenario],
  );

  if (!open) return null;

  const runSolver = async () => {
    setSelectedCandidateId(null);
    await solveAlternatives({
      maxCandidates,
      maxChangesPerCandidate: maxChanges,
      allowedStrategies,
      lockedNodeIds,
      ...(maximumCost ? { maximumMonthlyCostEur: Number(maximumCost) } : {}),
      ...(maximumComplexity
        ? { maximumOperationalComplexity: Number(maximumComplexity) }
        : {}),
    });
  };

  const applyCandidate = () => {
    if (!selectedCandidate) return;
    saveSnapshot(`Baseline before ${selectedCandidate.label}`);
    setArchitecture(structuredClone(selectedCandidate.architecture));
    setSelectedCandidateId(null);
  };

  const runRobustness = () => {
    setRobustnessRunning(true);
    setRobustnessError(null);
    window.setTimeout(() => {
      try {
        setRobustness(
          analyzeRobustness(scenario, architecture, {
            seedCount: 9,
            seedStride: 7_919,
          }),
        );
      } catch (error) {
        setRobustnessError(
          error instanceof Error
            ? error.message
            : "Robustness analysis failed.",
        );
      } finally {
        setRobustnessRunning(false);
      }
    }, 0);
  };

  const importProfile = () => {
    try {
      const profile = parseTrafficProfile(profileText);
      setScenario(applyTrafficProfile(scenario, profile));
      setProfileError(null);
      setProfileText("");
    } catch (error) {
      setProfileError(
        error instanceof Error
          ? error.message
          : "Traffic profile could not be imported.",
      );
    }
  };

  const importCatalog = () => {
    try {
      const next = parseProviderCatalog(catalogText);
      setCatalog(next);
      setCatalogSku(next.services[0]?.sku ?? "");
      setCatalogError(null);
    } catch (error) {
      setCatalogError(
        error instanceof Error
          ? error.message
          : "Provider catalog could not be imported.",
      );
    }
  };

  const selectedSku = catalog?.services.find((sku) => sku.sku === catalogSku);

  const calibrateNodeCost = () => {
    if (!selectedSku || !catalogNodeId) return;
    try {
      saveSnapshot(`Before ${catalog?.provider ?? "provider"} calibration`);
      setArchitecture(
        applyProviderSku(architecture, catalogNodeId, selectedSku),
      );
      setCatalogError(null);
    } catch (error) {
      setCatalogError(
        error instanceof Error
          ? error.message
          : "Provider SKU could not be applied.",
      );
    }
  };

  const elapsedSeconds = collaboration.startedAt
    ? Math.max(
        0,
        Math.floor((clockNow - Date.parse(collaboration.startedAt)) / 1_000),
      )
    : 0;
  const elapsedLabel = `${String(Math.floor(elapsedSeconds / 60)).padStart(2, "0")}:${String(elapsedSeconds % 60).padStart(2, "0")}`;

  return (
    <div
      className="decision-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="decision-workbench"
        role="dialog"
        aria-modal="true"
        aria-labelledby="decision-workbench-title"
        ref={dialogRef}
      >
        <header className="decision-header">
          <div>
            <span className="panel-index">DECISION WORKBENCH</span>
            <h2 id="decision-workbench-title">
              Architecture evidence and alternatives
            </h2>
          </div>
          <dl aria-label="Current decision state">
            <div>
              <dt>Scenario</dt>
              <dd>{scenario.title}</dd>
            </div>
            <div>
              <dt>Architecture</dt>
              <dd>{architecture.name}</dd>
            </div>
            <div>
              <dt>Trace</dt>
              <dd>
                {result
                  ? `${result.score.passed}/${result.score.total}`
                  : "not run"}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            className="decision-close"
            onClick={onClose}
            aria-label="Close decision workbench"
          >
            <X size={18} />
          </button>
        </header>

        <nav
          className="decision-tabs"
          role="tablist"
          aria-label="Decision tools"
        >
          {tabs
            .filter(
              ({ id }) => id !== "session" || scenario.mode === "interview",
            )
            .map(({ id, label, icon: Icon }) => (
              <button
                type="button"
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? "active" : ""}
                key={id}
                onClick={() => setTab(id)}
              >
                <Icon size={15} /> {label}
              </button>
            ))}
        </nav>

        <div className="decision-body">
          {tab === "solve" ? (
            <div className="decision-solve" role="tabpanel">
              <aside className="solver-controls">
                <header>
                  <span>Search contract</span>
                  <strong>Bound the decision space</strong>
                </header>
                <label>
                  Candidate budget
                  <input
                    type="number"
                    min="1"
                    max="64"
                    value={maxCandidates}
                    onChange={(event) =>
                      setMaxCandidates(
                        Math.max(1, Math.min(64, Number(event.target.value))),
                      )
                    }
                  />
                </label>
                <label>
                  Maximum changes
                  <select
                    value={maxChanges}
                    onChange={(event) =>
                      setMaxChanges(Number(event.target.value) as 1 | 2)
                    }
                  >
                    <option value="1">One change</option>
                    <option value="2">Two changes</option>
                  </select>
                </label>
                <label>
                  Monthly cost ceiling
                  <input
                    type="number"
                    min="0"
                    placeholder="Unbounded"
                    value={maximumCost}
                    onChange={(event) => setMaximumCost(event.target.value)}
                  />
                </label>
                <label>
                  Complexity ceiling
                  <input
                    type="number"
                    min="0"
                    placeholder="Unbounded"
                    value={maximumComplexity}
                    onChange={(event) =>
                      setMaximumComplexity(event.target.value)
                    }
                  />
                </label>
                <fieldset>
                  <legend>Allowed strategies</legend>
                  {SOLVER_STRATEGIES.map((strategy) => (
                    <label key={strategy}>
                      <input
                        type="checkbox"
                        checked={allowedStrategies.includes(strategy)}
                        onChange={(event) =>
                          setAllowedStrategies((current) =>
                            event.target.checked
                              ? [...current, strategy]
                              : current.filter(
                                  (candidate) => candidate !== strategy,
                                ),
                          )
                        }
                      />
                      {strategyLabels[strategy]}
                    </label>
                  ))}
                </fieldset>
                <fieldset className="solver-locks">
                  <legend>Locked components</legend>
                  {architecture.nodes.map((node) => (
                    <label key={node.id}>
                      <input
                        type="checkbox"
                        checked={lockedNodeIds.includes(node.id)}
                        onChange={(event) =>
                          setLockedNodeIds((current) =>
                            event.target.checked
                              ? [...current, node.id]
                              : current.filter((id) => id !== node.id),
                          )
                        }
                      />
                      <Lock size={11} /> {node.name}
                    </label>
                  ))}
                </fieldset>
                <button
                  type="button"
                  className="decision-primary"
                  disabled={
                    solverState === "running" || allowedStrategies.length === 0
                  }
                  onClick={() => void runSolver()}
                >
                  <Scales size={16} />
                  {solverState === "running"
                    ? "Searching alternatives…"
                    : "Compare candidates"}
                </button>
              </aside>

              <section
                className="candidate-table"
                aria-label="Solver candidate comparison"
              >
                <header>
                  <div>
                    <span>Candidate frontier</span>
                    <strong>
                      {solverResult
                        ? `${solverResult.exploredCandidates} explored · ${solverResult.paretoFrontierIds.length} Pareto`
                        : "Run a bounded comparison"}
                    </strong>
                  </div>
                  {solverExecution ? (
                    <small>{solverExecution} solver</small>
                  ) : null}
                </header>
                <div className="candidate-columns" aria-hidden="true">
                  <span>#</span>
                  <span>Candidate</span>
                  <span>Req.</span>
                  <span>p95 Δ</span>
                  <span>Cost Δ</span>
                  <span>State</span>
                </div>
                {solverResult ? (
                  <div className="candidate-list">
                    {solverResult.candidates.map((candidate) => (
                      <CandidateRow
                        key={candidate.id}
                        candidate={candidate}
                        recommended={
                          candidate.id === solverResult.recommendedCandidateId
                        }
                        onInspect={() => setSelectedCandidateId(candidate.id)}
                      />
                    ))}
                    {solverResult.candidates.length === 0 ? (
                      <div className="candidate-empty">
                        <CheckCircle size={22} />
                        <strong>
                          The baseline dominates the bounded search.
                        </strong>
                        <p>
                          No candidate improved the weighted objectives within
                          the selected constraints.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="candidate-empty">
                    <Scales size={24} />
                    <strong>Baseline awaiting comparison</strong>
                    <p>
                      SystemForge will show explicit changes, objective deltas,
                      constraints and trade-offs. It does not claim a global
                      optimum.
                    </p>
                  </div>
                )}
              </section>

              <aside className="candidate-inspector">
                {selectedCandidate ? (
                  <>
                    <header>
                      <span>Candidate {selectedCandidate.rank}</span>
                      <strong>{selectedCandidate.label}</strong>
                    </header>
                    <dl className="candidate-metrics">
                      <div>
                        <dt>Requirements</dt>
                        <dd>
                          {
                            selectedCandidate.evaluation.metrics
                              .requirementsPassed
                          }
                          /
                          {
                            selectedCandidate.evaluation.metrics
                              .requirementsTotal
                          }
                        </dd>
                      </div>
                      <div>
                        <dt>p95</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics.p95LatencyMs,
                            " ms",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Availability</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics.availability,
                            "%",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Monthly cost</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics.monthlyCostEur,
                            " EUR",
                          )}
                        </dd>
                      </div>
                    </dl>
                    <section>
                      <h3>Explicit changes</h3>
                      {selectedCandidate.changes.map((change) => (
                        <article
                          key={`${change.strategy}-${change.nodeIds.join("-")}`}
                        >
                          <strong>{change.title}</strong>
                          <p>{change.detail}</p>
                        </article>
                      ))}
                    </section>
                    <section>
                      <h3>Gains</h3>
                      <ul>
                        {selectedCandidate.improvements.map((value) => (
                          <li key={value}>{value}</li>
                        ))}
                      </ul>
                    </section>
                    <section>
                      <h3>Trade-offs</h3>
                      <ul>
                        {selectedCandidate.tradeoffs.map((value) => (
                          <li key={value}>{value}</li>
                        ))}
                      </ul>
                    </section>
                    {selectedCandidate.constraintViolations.length ? (
                      <section className="candidate-violations">
                        <h3>Constraint violations</h3>
                        <ul>
                          {selectedCandidate.constraintViolations.map(
                            (value) => (
                              <li key={value}>{value}</li>
                            ),
                          )}
                        </ul>
                      </section>
                    ) : null}
                    <button
                      type="button"
                      className="decision-primary"
                      disabled={!selectedCandidate.eligible}
                      onClick={applyCandidate}
                    >
                      <Sparkle size={16} /> Apply as a reversible version
                    </button>
                  </>
                ) : (
                  <div className="candidate-empty candidate-empty--side">
                    <GitBranch size={22} />
                    <strong>Select a candidate</strong>
                    <p>
                      The baseline remains untouched until you apply an eligible
                      alternative.
                    </p>
                  </div>
                )}
              </aside>

              <section className="robustness-strip">
                <div>
                  <span>Multi-seed confidence</span>
                  <strong>
                    Test whether this result survives controlled RNG variance
                  </strong>
                </div>
                {robustness ? (
                  <dl>
                    <div>
                      <dt>Objective pass rate</dt>
                      <dd>
                        {Math.round(robustness.requirementPassRate * 100)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Complete runs</dt>
                      <dd>
                        {Math.round(robustness.completeRunPassRate * 100)}%
                      </dd>
                    </div>
                    <div>
                      <dt>Median p95</dt>
                      <dd>
                        {formatMetric(
                          robustness.metrics.p95LatencyMs.median,
                          " ms",
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>p95-of-p95</dt>
                      <dd>
                        {formatMetric(
                          robustness.metrics.p95LatencyMs.p95,
                          " ms",
                        )}
                      </dd>
                    </div>
                  </dl>
                ) : (
                  <p>
                    {robustnessError ??
                      "Nine bounded deterministic seeds; results remain modeled rather than production-calibrated."}
                  </p>
                )}
                <button
                  type="button"
                  onClick={runRobustness}
                  disabled={robustnessRunning}
                >
                  <Flask size={15} />{" "}
                  {robustnessRunning
                    ? "Analyzing…"
                    : robustness
                      ? "Run again"
                      : "Analyze nine seeds"}
                </button>
              </section>
            </div>
          ) : null}

          {tab === "history" ? (
            <div className="history-workbench" role="tabpanel">
              <section className="history-controls">
                <header>
                  <span>Live edit history</span>
                  <strong>Every structural edit remains reversible</strong>
                </header>
                <div>
                  <button
                    type="button"
                    disabled={!undoCount}
                    onClick={undoArchitecture}
                  >
                    <ArrowCounterClockwise size={16} /> Undo{" "}
                    <small>{undoCount}</small>
                  </button>
                  <button
                    type="button"
                    disabled={!redoCount}
                    onClick={redoArchitecture}
                  >
                    <ArrowClockwise size={16} /> Redo <small>{redoCount}</small>
                  </button>
                </div>
                <label>
                  Name this architecture state
                  <span>
                    <input
                      value={snapshotLabel}
                      maxLength={80}
                      placeholder="Before regional failover"
                      onChange={(event) => setSnapshotLabel(event.target.value)}
                    />
                    <button
                      type="button"
                      disabled={!snapshotLabel.trim()}
                      onClick={() => {
                        saveSnapshot(snapshotLabel);
                        setSnapshotLabel("");
                      }}
                    >
                      <BookmarkSimple size={15} /> Save
                    </button>
                  </span>
                </label>
              </section>
              <section className="snapshot-ledger">
                <header>
                  <span>Named snapshots</span>
                  <strong>{snapshots.length} stored in this browser</strong>
                </header>
                {snapshots.length ? (
                  snapshots.map((snapshot) => (
                    <article key={snapshot.id}>
                      <div>
                        <strong>{snapshot.label}</strong>
                        <small>
                          {new Date(snapshot.createdAt).toLocaleString()} ·{" "}
                          {snapshot.architecture.nodes.length} nodes
                        </small>
                      </div>
                      <button
                        type="button"
                        onClick={() => restoreSnapshot(snapshot.id)}
                      >
                        Restore
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${snapshot.label}`}
                        onClick={() => removeSnapshot(snapshot.id)}
                      >
                        <Trash size={14} />
                      </button>
                    </article>
                  ))
                ) : (
                  <div className="candidate-empty">
                    <BookmarkSimple size={22} />
                    <strong>No named snapshots yet</strong>
                    <p>
                      Applying a solver candidate automatically preserves its
                      baseline.
                    </p>
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {tab === "missions" ? (
            <div className="mission-library" role="tabpanel">
              <header>
                <span>Curated mission library</span>
                <strong>
                  Five progressively different distributed-systems problems
                </strong>
                <p>
                  Loading a mission replaces the current scenario and
                  architecture after preserving the current topology as a named
                  snapshot.
                </p>
              </header>
              <div>
                {SCENARIO_LIBRARY.map((preset, index) => (
                  <article
                    key={preset.id}
                    className={preset.id === scenario.id ? "active" : ""}
                  >
                    <span>{String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <small>
                        {preset.domain} · {preset.difficulty}
                      </small>
                      <h3>{preset.scenario.title}</h3>
                      <p>{preset.scenario.summary}</p>
                    </div>
                    <dl>
                      <div>
                        <dt>Peak</dt>
                        <dd>
                          {preset.scenario.workload.peakRps.toLocaleString(
                            "en-US",
                          )}{" "}
                          RPS
                        </dd>
                      </div>
                      <div>
                        <dt>Incidents</dt>
                        <dd>{preset.scenario.incidents.length}</dd>
                      </div>
                      <div>
                        <dt>Objectives</dt>
                        <dd>{preset.scenario.requirements.length}</dd>
                      </div>
                    </dl>
                    <button
                      type="button"
                      disabled={preset.id === scenario.id}
                      onClick={() => {
                        saveSnapshot(`Before loading ${preset.scenario.title}`);
                        setScenario(structuredClone(preset.scenario));
                        setArchitecture(structuredClone(preset.architecture));
                      }}
                    >
                      {preset.id === scenario.id ? "Loaded" : "Load mission"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "calibrate" ? (
            <div className="calibration-workbench" role="tabpanel">
              <section className="profile-import">
                <header>
                  <UploadSimple size={18} />
                  <div>
                    <span>Traffic calibration</span>
                    <strong>Import CSV or OpenTelemetry-like JSON</strong>
                  </div>
                </header>
                <p>
                  Accepted observations are distilled into base RPS, peak RPS,
                  duration and an explicit peak incident. The raw trace is not
                  retained or represented as exact second-by-second calibration.
                </p>
                <textarea
                  value={profileText}
                  onChange={(event) => setProfileText(event.target.value)}
                  placeholder={"second,rps\n0,1200\n30,1800\n60,7200\n90,2100"}
                  aria-label="Traffic profile data"
                />
                {profileError ? (
                  <p className="decision-error" role="alert">
                    <Warning size={14} /> {profileError}
                  </p>
                ) : null}
                <button
                  type="button"
                  className="decision-primary"
                  disabled={!profileText.trim()}
                  onClick={importProfile}
                >
                  <UploadSimple size={16} /> Calibrate scenario
                </button>
              </section>
              <section className="topology-assistant">
                <div className="provider-catalog">
                  <header>
                    <DownloadSimple size={18} />
                    <div>
                      <span>Provider cost catalog</span>
                      <strong>Import a versioned pricing snapshot</strong>
                    </div>
                  </header>
                  <p>
                    Catalogs are explicit snapshots, not live-price claims.
                    SystemForge records per-instance monthly cost, compute
                    shape, egress and region in the model.
                  </p>
                  {!catalog ? (
                    <>
                      <textarea
                        value={catalogText}
                        onChange={(event) => setCatalogText(event.target.value)}
                        placeholder={
                          '{"schemaVersion":"1","provider":"Cloud","currency":"EUR","retrievedAt":"2026-08-08T00:00:00Z","services":[{"sku":"compute-m","name":"Compute M","componentKinds":["api"],"region":"eu-central","monthlyEur":72.5,"cpuCores":4,"memoryGb":16}]}'
                        }
                        aria-label="Provider pricing catalog JSON"
                      />
                      <button
                        type="button"
                        className="decision-primary"
                        disabled={!catalogText.trim()}
                        onClick={importCatalog}
                      >
                        Import catalog
                      </button>
                    </>
                  ) : (
                    <div className="provider-mapper">
                      <header>
                        <span>{catalog.provider}</span>
                        <small>
                          {catalog.services.length} SKUs · retrieved{" "}
                          {new Date(catalog.retrievedAt).toLocaleDateString()}
                        </small>
                      </header>
                      <label>
                        Architecture component
                        <select
                          value={catalogNodeId}
                          onChange={(event) =>
                            setCatalogNodeId(event.target.value)
                          }
                        >
                          {architecture.nodes.map((node) => (
                            <option key={node.id} value={node.id}>
                              {node.name} · {node.kind}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Provider SKU
                        <select
                          value={catalogSku}
                          onChange={(event) =>
                            setCatalogSku(event.target.value)
                          }
                        >
                          {catalog.services.map((sku) => (
                            <option key={sku.sku} value={sku.sku}>
                              {sku.name} ·{" "}
                              {formatMetric(sku.monthlyEur, " EUR/mo")}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="decision-primary"
                        disabled={!selectedSku}
                        onClick={calibrateNodeCost}
                      >
                        Apply pricing snapshot
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setCatalog(null);
                          setCatalogText("");
                        }}
                      >
                        Clear catalog
                      </button>
                    </div>
                  )}
                  {catalogError ? (
                    <p className="decision-error" role="alert">
                      <Warning size={14} /> {catalogError}
                    </p>
                  ) : null}
                </div>
                <header>
                  <Sparkle size={18} />
                  <div>
                    <span>Assistive synthesis</span>
                    <strong>
                      Explicit structural proposals, never an invisible answer
                    </strong>
                  </div>
                </header>
                {topologyProposals.length ? (
                  topologyProposals.map((proposal) => (
                    <article key={proposal.id}>
                      <div>
                        <strong>{proposal.title}</strong>
                        <p>{proposal.rationale}</p>
                        <small>Trade-off · {proposal.tradeoff}</small>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          saveSnapshot(`Before ${proposal.title}`);
                          setArchitecture(
                            applyTopologyProposal(architecture, proposal),
                          );
                        }}
                      >
                        Apply proposal
                      </button>
                    </article>
                  ))
                ) : (
                  <div className="candidate-empty">
                    <CheckCircle size={22} />
                    <strong>No obvious missing structural primitive</strong>
                    <p>
                      Use the bounded solver to tune existing capacity,
                      resilience and operating policy.
                    </p>
                  </div>
                )}
              </section>
            </div>
          ) : null}

          {tab === "session" && scenario.mode === "interview" ? (
            <div className="session-workbench" role="tabpanel">
              <header className="session-status">
                <div>
                  <span>Interview room</span>
                  <strong>
                    {sharedScenarioId
                      ? "Canonical collaboration connected"
                      : "Local interview draft"}
                  </strong>
                  <p>
                    {sharedScenarioId
                      ? "The candidate journal, location and shared clock synchronize through the canonical API. Interviewer notes never appear in participant responses."
                      : "Publish this interview from the authoring page to create separate participant and interviewer links."}
                  </p>
                </div>
                <div className="session-clock" aria-live="polite">
                  <Timer size={20} />
                  <span>
                    {collaboration.startedAt ? "Elapsed" : "Clock idle"}
                  </span>
                  <strong>{elapsedLabel}</strong>
                  {role === "interviewer" ? (
                    <button
                      type="button"
                      disabled={!sharedScenarioId}
                      onClick={() =>
                        void updateCollaboration({
                          clockAction: collaboration.startedAt
                            ? "reset"
                            : "start",
                        })
                      }
                    >
                      {collaboration.startedAt ? "Reset" : "Start"}
                    </button>
                  ) : null}
                </div>
              </header>
              <div className="session-columns">
                <section>
                  <header>
                    <span>Shared candidate journal</span>
                    <strong>Clarifications, assumptions and decisions</strong>
                  </header>
                  <label>
                    Candidate location
                    <select
                      value={candidateCursor}
                      onChange={(event) =>
                        setCandidateCursor(event.target.value)
                      }
                    >
                      <option>Preparing workspace</option>
                      <option>Clarifying requirements</option>
                      <option>Designing topology</option>
                      <option>Running failure tests</option>
                      <option>Investigating evidence</option>
                      <option>Comparing alternatives</option>
                      <option>Summarizing trade-offs</option>
                    </select>
                  </label>
                  <label>
                    Shared notes
                    <textarea
                      maxLength={4000}
                      value={candidateNotes}
                      onChange={(event) =>
                        setCandidateNotes(event.target.value)
                      }
                      placeholder="Record assumptions, rejected options, unanswered questions and the reason behind each decision."
                    />
                  </label>
                  <footer>
                    <small>
                      {candidateNotes.length.toLocaleString("en-US")} / 4,000
                      characters
                    </small>
                    <button
                      type="button"
                      className="decision-primary"
                      disabled={!sharedScenarioId}
                      onClick={() =>
                        void updateCollaboration({
                          candidateNotes,
                          candidateCursor,
                        })
                      }
                    >
                      Synchronize journal
                    </button>
                  </footer>
                </section>
                {role === "interviewer" ? (
                  <section className="private-session-notes">
                    <header>
                      <Lock size={16} />
                      <div>
                        <span>Private interviewer notes</span>
                        <strong>Never returned to participant links</strong>
                      </div>
                    </header>
                    <textarea
                      maxLength={4000}
                      value={interviewerNotes}
                      onChange={(event) =>
                        setInterviewerNotes(event.target.value)
                      }
                      placeholder="Capture evidence against the private rubric, follow-up prompts and evaluation notes."
                    />
                    <footer>
                      <small>
                        {interviewerNotes.length.toLocaleString("en-US")} /
                        4,000 characters
                      </small>
                      <button
                        type="button"
                        disabled={!sharedScenarioId}
                        onClick={() =>
                          void updateCollaboration({ interviewerNotes })
                        }
                      >
                        Save private notes
                      </button>
                    </footer>
                  </section>
                ) : (
                  <section className="candidate-presence">
                    <UsersThree size={24} />
                    <span>Shared location</span>
                    <strong>{collaboration.candidateCursor}</strong>
                    <p>
                      The interviewer can follow your current phase and the
                      shared journal. Their rubric and notes remain isolated.
                    </p>
                  </section>
                )}
              </div>
            </div>
          ) : null}

          {tab === "report" ? (
            <div className="evidence-workbench" role="tabpanel">
              <header>
                <span>Portable evidence</span>
                <strong>Export the current modeled decision record</strong>
                <p>
                  Participant exports automatically remove hidden interview
                  criteria. Reports distinguish deterministic model output from
                  production telemetry.
                </p>
              </header>
              <div className="evidence-actions">
                <button
                  type="button"
                  onClick={() =>
                    downloadEvidenceReport({
                      scenario,
                      architecture,
                      result,
                      solverResult,
                      role,
                      format: "json",
                    })
                  }
                >
                  <DownloadSimple size={19} />
                  <strong>JSON evidence bundle</strong>
                  <span>
                    Structured scenario, architecture, outcomes and candidate
                    deltas.
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    downloadEvidenceReport({
                      scenario,
                      architecture,
                      result,
                      solverResult,
                      role,
                      format: "markdown",
                    })
                  }
                >
                  <FileText size={19} />
                  <strong>Markdown decision record</strong>
                  <span>
                    Readable objectives, analysis, improvements and trade-offs.
                  </span>
                </button>
                <button type="button" onClick={() => window.print()}>
                  <Printer size={19} />
                  <strong>Print or save as PDF</strong>
                  <span>
                    Uses the browser’s native accessible print and PDF workflow.
                  </span>
                </button>
              </div>
              <section className="evidence-boundary">
                <CheckCircle size={18} />
                <div>
                  <strong>Privacy and evidence boundary enforced</strong>
                  <p>
                    {role === "interviewer"
                      ? "This interviewer export may include the private rubric."
                      : "This participant export cannot include hidden rubric requirements or the interviewer brief."}
                  </p>
                </div>
              </section>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
