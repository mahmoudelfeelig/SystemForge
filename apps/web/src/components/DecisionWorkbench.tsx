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
import { componentOwnsState } from "@systemforge/contracts";
import {
  SOLVER_STRATEGIES,
  type RobustnessResult,
  type SolverCandidate,
  type SolverStrategy,
} from "@systemforge/sim-core";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  downloadCompletedRunManifest,
  downloadEvidenceReport,
} from "../lib/evidenceReport";
import {
  completedRunReplayExportAvailability,
  downloadCompletedRunReplayBundle,
} from "../lib/replayBundle";
import {
  applyProviderSku,
  parseProviderCatalog,
  type ProviderCatalog,
} from "../lib/providerCatalog";
import {
  RobustnessAnalysisCancelledError,
  startRobustnessAnalysis,
  type RobustnessAnalysisIdentity,
  type RobustnessAnalysisProgress,
  type RobustnessAnalysisSession,
} from "../lib/robustnessAnalysis";
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
import { InterviewAiFacilitator, RunAiDebriefPanel } from "./AiAssistantPanels";
import { RunHistoryPanel } from "./RunHistoryPanel";

type DecisionTab =
  | "solve"
  | "runs"
  | "history"
  | "missions"
  | "calibrate"
  | "session"
  | "report";

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
  { id: "runs", label: "Runs", icon: Timer },
  { id: "history", label: "Versions", icon: GitBranch },
  { id: "missions", label: "Scenarios", icon: Books },
  { id: "calibrate", label: "Imports", icon: Flask },
  { id: "session", label: "Session", icon: UsersThree },
  { id: "report", label: "Report", icon: FileText },
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

let robustnessRequestSequence = 0;

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
      <span data-label="Objectives">
        {candidate.evaluation.metrics.requirementsPassed}/
        {candidate.evaluation.metrics.requirementsTotal}
      </span>
      <span
        data-label="p95 change"
        className={metricDeltaClass(candidate.deltas.p95LatencyMs, true)}
      >
        {candidate.deltas.p95LatencyMs > 0 ? "+" : ""}
        {formatMetric(candidate.deltas.p95LatencyMs, " ms")}
      </span>
      <span
        data-label="Cost change"
        className={metricDeltaClass(candidate.deltas.monthlyCostEur, true)}
      >
        {candidate.deltas.monthlyCostEur > 0 ? "+" : ""}
        {formatMetric(candidate.deltas.monthlyCostEur, " EUR")}
      </span>
      <span className="candidate-flags" data-label="State">
        {recommended ? <b>Top-ranked</b> : null}
        {candidate.paretoOptimal ? <i>Pareto</i> : null}
        {!candidate.eligible ? <em>Ineligible</em> : null}
      </span>
    </button>
  );
}

export function DecisionWorkbench({ open, onClose }: DecisionWorkbenchProps) {
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const scenarioRevision = useLabStore((state) => state.scenarioRevision);
  const architectureRevision = useLabStore(
    (state) => state.architectureRevision,
  );
  const result = useLabStore((state) => state.result);
  const runState = useLabStore((state) => state.runState);
  const completedRunArtifact = useLabStore(
    (state) => state.completedRunArtifact,
  );
  const completedRunFork = useLabStore((state) => state.completedRunFork);
  const solverResult = useLabStore((state) => state.solverResult);
  const solverState = useLabStore((state) => state.solverState);
  const solverExecution = useLabStore((state) => state.solverExecution);
  const notice = useLabStore((state) => state.notice);
  const role = useLabStore((state) => state.role);
  const sharedScenarioId = useLabStore((state) => state.sharedScenarioId);
  const collaboration = useLabStore((state) => state.collaboration);
  const snapshots = useLabStore((state) => state.architectureSnapshots);
  const undoCount = useLabStore((state) => state.architectureUndo.length);
  const redoCount = useLabStore((state) => state.architectureRedo.length);
  const setScenario = useLabStore((state) => state.setScenario);
  const setArchitecture = useLabStore((state) => state.setArchitecture);
  const replayCompletedRun = useLabStore((state) => state.replayCompletedRun);
  const forkCompletedRun = useLabStore((state) => state.forkCompletedRun);
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
  const [maxCandidates, setMaxCandidates] = useState(12);
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
  const [replayExportError, setReplayExportError] = useState<string | null>(
    null,
  );
  const [catalogNodeId, setCatalogNodeId] = useState(
    architecture.nodes[0]?.id ?? "",
  );
  const [catalogSku, setCatalogSku] = useState("");
  const [robustness, setRobustness] = useState<RobustnessResult | null>(null);
  const [robustnessError, setRobustnessError] = useState<string | null>(null);
  const [robustnessRunning, setRobustnessRunning] = useState(false);
  const [robustnessProgress, setRobustnessProgress] =
    useState<RobustnessAnalysisProgress | null>(null);
  const robustnessSessionRef = useRef<RobustnessAnalysisSession | null>(null);
  const robustnessInputRef = useRef({
    scenarioRevision,
    architectureRevision,
    scenarioId: scenario.id,
    architectureId: architecture.id,
  });
  robustnessInputRef.current = {
    scenarioRevision,
    architectureRevision,
    scenarioId: scenario.id,
    architectureId: architecture.id,
  };
  const [candidateNotes, setCandidateNotes] = useState(
    collaboration.candidateNotes,
  );
  const [interviewerNotes, setInterviewerNotes] = useState(
    collaboration.interviewerNotes ?? "",
  );
  const [candidateCursor, setCandidateCursor] = useState(
    collaboration.candidateCursor,
  );
  const [interviewAssistantQuestions, setInterviewAssistantQuestions] =
    useState<string[]>([]);
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
    const knownNodeIds = new Set(architecture.nodes.map((node) => node.id));
    setLockedNodeIds((current) => current.filter((id) => knownNodeIds.has(id)));
  }, [architecture.nodes]);

  useEffect(() => {
    const session = robustnessSessionRef.current;
    robustnessSessionRef.current = null;
    session?.cancel();
    setRobustness(null);
    setRobustnessError(null);
    setRobustnessRunning(false);
    setRobustnessProgress(null);
  }, [architectureRevision, scenarioRevision]);

  useEffect(() => {
    setInterviewAssistantQuestions([]);
  }, [architectureRevision, role, scenarioRevision]);

  useEffect(() => {
    if (open) return;
    const session = robustnessSessionRef.current;
    robustnessSessionRef.current = null;
    session?.cancel();
    setRobustnessRunning(false);
    setRobustnessProgress(null);
  }, [open]);

  useEffect(
    () => () => {
      const session = robustnessSessionRef.current;
      robustnessSessionRef.current = null;
      session?.cancel();
    },
    [],
  );

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
  const baselineMonthlyCost = architecture.nodes.reduce(
    (total, node) =>
      total +
      node.config.monthlyCostEur *
        (componentOwnsState(node.kind)
          ? Math.max(node.config.instances, node.config.replicas + 1)
          : node.config.instances),
    0,
  );
  const replayExportAvailability = completedRunArtifact
    ? completedRunReplayExportAvailability(completedRunArtifact)
    : {
        allowed: false,
        reason:
          "Complete a local modeled run before exporting a replay bundle.",
      };

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

  const identityIsCurrent = (identity: RobustnessAnalysisIdentity) => {
    const current = robustnessInputRef.current;
    return (
      identity.scenarioRevision === current.scenarioRevision &&
      identity.architectureRevision === current.architectureRevision &&
      identity.scenarioId === current.scenarioId &&
      identity.architectureId === current.architectureId
    );
  };

  const runRobustness = async () => {
    const previous = robustnessSessionRef.current;
    robustnessSessionRef.current = null;
    previous?.cancel();

    const identity: RobustnessAnalysisIdentity = {
      requestId: `robustness-${scenarioRevision}-${architectureRevision}-${++robustnessRequestSequence}`,
      scenarioRevision,
      architectureRevision,
      scenarioId: scenario.id,
      architectureId: architecture.id,
    };
    setRobustnessRunning(true);
    setRobustness(null);
    setRobustnessError(null);
    setRobustnessProgress({ completedSeeds: 0, totalSeeds: 9, progress: 0 });

    const session = startRobustnessAnalysis(scenario, architecture, {
      identity,
      seedCount: 9,
      seedStride: 7_919,
      onProgress: (progress) => {
        if (
          robustnessSessionRef.current?.identity.requestId ===
            identity.requestId &&
          identityIsCurrent(identity)
        )
          setRobustnessProgress(progress);
      },
    });
    robustnessSessionRef.current = session;

    try {
      const nextRobustness = await session.result;
      if (
        robustnessSessionRef.current !== session ||
        !identityIsCurrent(identity)
      )
        return;
      setRobustness(nextRobustness);
    } catch (error) {
      if (
        robustnessSessionRef.current !== session ||
        !identityIsCurrent(identity)
      )
        return;
      setRobustnessError(
        error instanceof RobustnessAnalysisCancelledError
          ? "Analysis cancelled. No robustness result was produced."
          : error instanceof Error
            ? error.message
            : "Robustness analysis failed without a result.",
      );
    } finally {
      if (robustnessSessionRef.current === session) {
        robustnessSessionRef.current = null;
        setRobustnessRunning(false);
        setRobustnessProgress(null);
      }
    }
  };

  const cancelRobustness = () => {
    const session = robustnessSessionRef.current;
    if (!session) return;
    robustnessSessionRef.current = null;
    session.cancel();
    setRobustness(null);
    setRobustnessRunning(false);
    setRobustnessProgress(null);
    setRobustnessError(
      "Analysis cancelled. No robustness result was produced.",
    );
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
  const visibleTabs = tabs.filter(
    ({ id }) => id !== "session" || scenario.mode === "interview",
  );
  const moveTabFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentId: DecisionTab,
  ) => {
    const currentIndex = visibleTabs.findIndex(({ id }) => id === currentId);
    let nextIndex: number;
    if (event.key === "ArrowRight")
      nextIndex = (currentIndex + 1) % visibleTabs.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + visibleTabs.length) % visibleTabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = visibleTabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = visibleTabs[nextIndex]?.id;
    if (!nextTab) return;
    setTab(nextTab);
    document.getElementById(`decision-tab-${nextTab}`)?.focus();
  };

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
            <h2 id="decision-workbench-title">Compare designs</h2>
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
              <dt>Run score</dt>
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
          {visibleTabs.map(({ id, label, icon: Icon }) => (
            <button
              id={`decision-tab-${id}`}
              type="button"
              role="tab"
              aria-selected={tab === id}
              aria-controls={`decision-panel-${id}`}
              tabIndex={tab === id ? 0 : -1}
              className={tab === id ? "active" : ""}
              key={id}
              onClick={() => setTab(id)}
              onKeyDown={(event) => moveTabFocus(event, id)}
            >
              <Icon size={15} /> {label}
            </button>
          ))}
        </nav>
        <label className="decision-tool-select">
          Decision tool
          <select
            value={tab}
            onChange={(event) => setTab(event.target.value as DecisionTab)}
          >
            {visibleTabs.map(({ id, label }) => (
              <option value={id} key={id}>
                {label}
              </option>
            ))}
          </select>
        </label>

        <div className="decision-body">
          {tab === "solve" ? (
            <div
              id="decision-panel-solve"
              className={`decision-solve${selectedCandidate ? " decision-solve--inspecting" : ""}`}
              role="tabpanel"
              aria-labelledby="decision-tab-solve"
            >
              <aside className="solver-controls">
                <header>
                  <span>Search limits</span>
                  <strong>Run bounded search</strong>
                </header>
                <label>
                  Candidate budget
                  <input
                    type="number"
                    min="1"
                    max="12"
                    value={maxCandidates}
                    onChange={(event) =>
                      setMaxCandidates(
                        Math.max(1, Math.min(12, Number(event.target.value))),
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
                <details className="solver-advanced">
                  <summary>
                    <span>
                      <strong>Advanced constraints</strong>
                      <small>
                        {allowedStrategies.length} strategies ·{" "}
                        {lockedNodeIds.length} locked components
                      </small>
                    </span>
                  </summary>
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
                </details>
              </aside>

              <section
                className="candidate-table"
                aria-label="Solver candidate comparison"
              >
                <header>
                  <div>
                    <span>Candidate results</span>
                    <strong>
                      {solverResult
                        ? `${solverResult.exploredCandidates} explored · ${solverResult.paretoFrontierIds.length} Pareto`
                        : "The current design is not modified"}
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
                {solverState === "error" ? (
                  <p className="decision-error" role="alert">
                    <Warning size={14} />
                    {notice ?? "The candidate comparison could not complete."}
                  </p>
                ) : null}
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
                        <Scales size={22} />
                        <strong>No candidate was returned</strong>
                        <p>
                          The bounded search may have had no eligible mutation,
                          exhausted its budget, or found no qualifying result.
                          This does not prove the baseline is optimal.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="candidate-empty">
                    <Scales size={24} />
                    <strong>Current design</strong>
                    <p>
                      Run the search to compare explicit changes. It does not
                      claim a global optimum.
                    </p>
                    <dl className="baseline-summary">
                      <div>
                        <dt>Components</dt>
                        <dd>{architecture.nodes.length}</dd>
                      </div>
                      <div>
                        <dt>Links</dt>
                        <dd>{architecture.edges.length}</dd>
                      </div>
                      <div>
                        <dt>Objectives</dt>
                        <dd>{scenario.requirements.length}</dd>
                      </div>
                      <div>
                        <dt>Configured cost</dt>
                        <dd>{formatMetric(baselineMonthlyCost, " EUR/mo")}</dd>
                      </div>
                    </dl>
                  </div>
                )}
              </section>

              {selectedCandidate ? (
                <aside className="candidate-inspector">
                  <>
                    <header>
                      <div>
                        <span>Candidate {selectedCandidate.rank}</span>
                        <strong>{selectedCandidate.label}</strong>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedCandidateId(null)}
                        aria-label="Close candidate details"
                      >
                        <X size={16} />
                      </button>
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
                        <dt>Peak error</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics.errorRate,
                            "%",
                          )}{" "}
                          (Δ {selectedCandidate.deltas.errorRate > 0 ? "+" : ""}
                          {formatMetric(
                            selectedCandidate.deltas.errorRate,
                            "%",
                          )}
                          )
                        </dd>
                      </div>
                      <div>
                        <dt>Durability</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics
                              .durabilityPercent,
                            "%",
                          )}{" "}
                          (Δ{" "}
                          {selectedCandidate.deltas.durabilityPercent > 0
                            ? "+"
                            : ""}
                          {formatMetric(
                            selectedCandidate.deltas.durabilityPercent,
                            "%",
                          )}
                          )
                        </dd>
                      </div>
                      <div>
                        <dt>Modeled data loss</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics.dataLoss,
                          )}{" "}
                          (Δ {selectedCandidate.deltas.dataLoss > 0 ? "+" : ""}
                          {formatMetric(selectedCandidate.deltas.dataLoss)})
                        </dd>
                      </div>
                      <div>
                        <dt>Recovery</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics
                              .recoveryTimeSeconds,
                            " s",
                          )}{" "}
                          (Δ{" "}
                          {selectedCandidate.deltas.recoveryTimeSeconds > 0
                            ? "+"
                            : ""}
                          {formatMetric(
                            selectedCandidate.deltas.recoveryTimeSeconds,
                            " s",
                          )}
                          )
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
                      <div>
                        <dt>Complexity</dt>
                        <dd>
                          {formatMetric(
                            selectedCandidate.evaluation.metrics
                              .operationalComplexity,
                          )}{" "}
                          (Δ{" "}
                          {selectedCandidate.deltas.operationalComplexity > 0
                            ? "+"
                            : ""}
                          {formatMetric(
                            selectedCandidate.deltas.operationalComplexity,
                          )}
                          )
                        </dd>
                      </div>
                    </dl>
                    {solverResult ? (
                      <section>
                        <h3>Ranking inputs</h3>
                        <p>
                          Requirements{" "}
                          {Math.round(
                            solverResult.options.weights.requirements * 100,
                          )}
                          %{" · "}resilience{" "}
                          {Math.round(
                            solverResult.options.weights.resilience * 100,
                          )}
                          %{" · "}latency{" "}
                          {Math.round(
                            solverResult.options.weights.latency * 100,
                          )}
                          %{" · "}cost{" "}
                          {Math.round(solverResult.options.weights.cost * 100)}%
                          {" · "}complexity{" "}
                          {Math.round(
                            solverResult.options.weights.complexity * 100,
                          )}
                          %.
                        </p>
                        <p>
                          Hard limits:{" "}
                          {solverResult.options.maximumMonthlyCostEur ===
                          undefined
                            ? "no cost ceiling"
                            : `${formatMetric(solverResult.options.maximumMonthlyCostEur, " EUR/mo")}`}
                          {" · "}
                          {solverResult.options.maximumOperationalComplexity ===
                          undefined
                            ? "no complexity ceiling"
                            : `complexity ${formatMetric(solverResult.options.maximumOperationalComplexity)}`}
                          {" · "}
                          {solverResult.options.lockedNodeIds.length} locked
                          nodes.
                        </p>
                      </section>
                    ) : null}
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
                      <Sparkle size={16} /> Apply candidate
                    </button>
                  </>
                </aside>
              ) : null}

              <section className="robustness-strip">
                <div>
                  <span>Seed sensitivity</span>
                  <strong>Run the same design across nine seeds</strong>
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
                  <p aria-live="polite">
                    {robustnessRunning && robustnessProgress
                      ? `Completed ${robustnessProgress.completedSeeds} of ${robustnessProgress.totalSeeds} deterministic seed runs (${Math.round(robustnessProgress.progress * 100)}%).`
                      : (robustnessError ??
                        "Nine bounded deterministic seeds; results remain modeled rather than production-calibrated.")}
                  </p>
                )}
                <button
                  type="button"
                  onClick={
                    robustnessRunning
                      ? cancelRobustness
                      : () => void runRobustness()
                  }
                >
                  <Flask size={15} />{" "}
                  {robustnessRunning
                    ? "Cancel analysis"
                    : robustness
                      ? "Run again"
                      : "Analyze seed sensitivity"}
                </button>
              </section>
            </div>
          ) : null}

          {tab === "runs" ? <RunHistoryPanel onReplay={onClose} /> : null}

          {tab === "history" ? (
            <div
              id="decision-panel-history"
              className="history-workbench"
              role="tabpanel"
              aria-labelledby="decision-tab-history"
            >
              <section className="history-controls">
                <header>
                  <span>Saved versions</span>
                  <strong>Restore recent edits or a named snapshot</strong>
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
                  <span>Named versions</span>
                  <strong>{snapshots.length} saved in this browser</strong>
                </header>
                {completedRunFork ? (
                  <section
                    className="evidence-boundary"
                    aria-label="Current completed-run fork"
                  >
                    <GitBranch size={18} />
                    <div>
                      <strong>
                        Static run-input fork is the current Lab draft
                      </strong>
                      <p>
                        Source run {completedRunFork.provenance.sourceRunId} at
                        delivered second{" "}
                        {completedRunFork.snapshot.deliveredSecond}. The fork
                        copied captured inputs; it did not restore in-flight
                        state or recompute the original run.
                      </p>
                      <button
                        type="button"
                        className="decision-primary"
                        onClick={onClose}
                      >
                        Open current fork draft in Lab
                      </button>
                    </div>
                  </section>
                ) : completedRunArtifact ? (
                  <section
                    className="evidence-boundary"
                    aria-label="Completed run fork point"
                  >
                    <GitBranch size={18} />
                    <div>
                      <strong>
                        Completed run available as a static fork point
                      </strong>
                      <p>
                        The selected delivered frame is provenance only. A fork
                        copies the captured scenario and architecture without
                        restoring queues, replicas, memory, or in-flight work.
                      </p>
                      <button
                        type="button"
                        className="decision-primary"
                        onClick={() =>
                          forkCompletedRun(
                            completedRunArtifact.manifest.snapshot
                              .deliveredSecond,
                          )
                        }
                      >
                        Create and apply static fork
                      </button>
                    </div>
                  </section>
                ) : null}
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
            <div
              id="decision-panel-missions"
              className="mission-library"
              role="tabpanel"
              aria-labelledby="decision-tab-missions"
            >
              <header>
                <span>Scenario library</span>
                <strong>Five distributed-systems scenarios</strong>
                <p>Loading a scenario saves the current architecture first.</p>
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
                      {preset.id === scenario.id ? "Loaded" : "Load scenario"}
                    </button>
                  </article>
                ))}
              </div>
            </div>
          ) : null}

          {tab === "calibrate" ? (
            <div
              id="decision-panel-calibrate"
              className="calibration-workbench"
              role="tabpanel"
              aria-labelledby="decision-tab-calibrate"
            >
              <section className="profile-import">
                <header>
                  <UploadSimple size={18} />
                  <div>
                    <span>Import workload profile</span>
                    <strong>Import CSV or sampled RPS JSON</strong>
                  </div>
                </header>
                <p>
                  Sets duration from the last timestamp, base RPS to the median,
                  peak RPS to the maximum, and adds one scheduled traffic-spike
                  incident. Raw samples are not replayed or retained.
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
                  <UploadSimple size={16} /> Apply workload summary
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
                    <span>Suggested configuration changes</span>
                    <strong>
                      Rule-based suggestions from the current scenario and
                      component list
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
                    <strong>
                      No rule-based component suggestion for this scenario
                    </strong>
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
            <div
              id="decision-panel-session"
              className="session-workbench"
              role="tabpanel"
              aria-labelledby="decision-tab-session"
            >
              <header className="session-status">
                <div>
                  <span>Interview room</span>
                  <strong>
                    {sharedScenarioId
                      ? "Server-backed interview connected"
                      : "Local interview draft"}
                  </strong>
                  <p>
                    {sharedScenarioId
                      ? "The candidate journal, phase, and shared clock synchronize through the online service. Interviewer notes never appear in candidate responses."
                      : "Create a server-backed interview from the authoring page to get separate candidate and interviewer links."}
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
              <InterviewAiFacilitator
                candidateNotes={candidateNotes}
                candidatePhase={candidateCursor}
                previousQuestions={interviewAssistantQuestions}
                onQuestionGenerated={(question) =>
                  setInterviewAssistantQuestions((current) =>
                    [...current, question].slice(-20),
                  )
                }
              />
              <div className="session-columns">
                <section>
                  <header>
                    <span>Shared candidate journal</span>
                    <strong>Clarifications, assumptions and decisions</strong>
                  </header>
                  <label>
                    Candidate phase
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
                      Save shared notes
                    </button>
                  </footer>
                </section>
                {role === "interviewer" ? (
                  <section className="private-session-notes">
                    <header>
                      <Lock size={16} />
                      <div>
                        <span>Private interviewer notes</span>
                        <strong>Never returned to candidate links</strong>
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
            <div
              id="decision-panel-report"
              className="evidence-workbench"
              role="tabpanel"
              aria-labelledby="decision-tab-report"
            >
              <header>
                <span>Run report</span>
                <strong>Export run evidence</strong>
                <p>
                  Hidden interview criteria are removed from candidate exports.
                </p>
              </header>
              <RunAiDebriefPanel />
              {completedRunArtifact ? (
                <section aria-label="Completed run manifest">
                  <dl className="baseline-summary">
                    <div>
                      <dt>Run ID</dt>
                      <dd>{completedRunArtifact.manifest.runId}</dd>
                    </div>
                    <div>
                      <dt>Engine</dt>
                      <dd>{completedRunArtifact.manifest.engineVersion}</dd>
                    </div>
                    <div>
                      <dt>Seed</dt>
                      <dd>
                        {completedRunArtifact.manifest.seed.toLocaleString(
                          "en-US",
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Actions</dt>
                      <dd>
                        {completedRunArtifact.manifest.actionLog.length.toLocaleString(
                          "en-US",
                        )}
                      </dd>
                    </div>
                  </dl>
                  <dl className="baseline-summary baseline-summary--stacked">
                    <div>
                      <dt>Scenario</dt>
                      <dd>
                        {completedRunArtifact.manifest.scenario.id} · schema v
                        {completedRunArtifact.manifest.scenario.schemaVersion} ·
                        revision{" "}
                        {completedRunArtifact.manifest.scenario.revision}
                      </dd>
                    </div>
                    <div>
                      <dt>Architecture</dt>
                      <dd>
                        {completedRunArtifact.manifest.architecture.id} · schema
                        v
                        {
                          completedRunArtifact.manifest.architecture
                            .schemaVersion
                        }{" "}
                        · revision{" "}
                        {completedRunArtifact.manifest.architecture.revision}
                      </dd>
                    </div>
                    <div>
                      <dt>Result digest</dt>
                      <dd>
                        {completedRunArtifact.manifest.resultDigest.algorithm} ·{" "}
                        {completedRunArtifact.manifest.resultDigest.value}
                      </dd>
                    </div>
                    <div>
                      <dt>Snapshot</dt>
                      <dd>
                        Delivered second{" "}
                        {completedRunArtifact.manifest.snapshot.deliveredSecond}{" "}
                        · {completedRunArtifact.manifest.snapshot.selection}
                      </dd>
                    </div>
                    <div>
                      <dt>Replay evidence</dt>
                      <dd>
                        {completedRunArtifact.manifest.replay
                          ? completedRunArtifact.manifest.replay.verified
                            ? `Verified against ${completedRunArtifact.manifest.replay.sourceRunId}`
                            : `Not verified against ${completedRunArtifact.manifest.replay.sourceRunId}`
                          : "Original completed run"}
                      </dd>
                    </div>
                  </dl>
                </section>
              ) : (
                <div className="candidate-empty">
                  <FileText size={22} />
                  <strong>No completed run yet</strong>
                  <p>
                    Complete a local modeled run to capture its identity,
                    digest, action log, and a delivered-frame snapshot.
                  </p>
                </div>
              )}
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
                  <strong>JSON run bundle</strong>
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
                <button
                  type="button"
                  disabled={!completedRunArtifact}
                  onClick={() => {
                    if (completedRunArtifact)
                      downloadCompletedRunManifest(completedRunArtifact);
                  }}
                >
                  <DownloadSimple size={19} />
                  <strong>Completed-run manifest</strong>
                  <span>
                    Evidence-only identity, digest, action log, and selected
                    frame. This file cannot be imported or replayed.
                  </span>
                </button>
                <button
                  type="button"
                  disabled={
                    !completedRunArtifact || !replayExportAvailability.allowed
                  }
                  onClick={() => {
                    if (!completedRunArtifact) return;
                    setReplayExportError(null);
                    void downloadCompletedRunReplayBundle(
                      completedRunArtifact,
                    ).catch((error: unknown) => {
                      setReplayExportError(
                        error instanceof Error
                          ? error.message
                          : "The replay bundle could not be exported.",
                      );
                    });
                  }}
                >
                  <DownloadSimple size={19} />
                  <strong>Portable replay bundle</strong>
                  <span>
                    {replayExportAvailability.allowed
                      ? "Candidate-safe inputs, action schedule, engine and profile evidence, and source result digest."
                      : replayExportAvailability.reason}
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!completedRunArtifact || runState === "running"}
                  onClick={() => {
                    onClose();
                    void replayCompletedRun();
                  }}
                >
                  <ArrowClockwise size={19} />
                  <strong>Replay captured inputs</strong>
                  <span>
                    Restores the captured scenario and architecture, then starts
                    a fresh deterministic run at modeled second 0.
                  </span>
                </button>
                <button
                  type="button"
                  disabled={!completedRunArtifact}
                  onClick={() => {
                    if (completedRunArtifact)
                      forkCompletedRun(
                        completedRunArtifact.manifest.snapshot.deliveredSecond,
                      );
                  }}
                >
                  <GitBranch size={19} />
                  <strong>Create and apply static fork</strong>
                  <span>
                    Copies captured inputs into the current draft. The selected
                    frame is provenance only; in-flight state is not restored.
                  </span>
                </button>
              </div>
              {replayExportError ? (
                <p className="field-error" role="alert">
                  {replayExportError}
                </p>
              ) : null}
              <section className="evidence-boundary">
                <Warning size={18} />
                <div>
                  <strong>Replay and fork boundary</strong>
                  <p>
                    Replay starts from modeled second 0. Snapshot selection and
                    static forks do not restore in-flight queues, replica state,
                    memory, or requests, and do not recompute mid-run physics.
                  </p>
                </div>
              </section>
              <section className="evidence-boundary">
                <BookmarkSimple size={18} />
                <div>
                  <strong>Browser-session completed-run evidence</strong>
                  <p>
                    The full completed artifact is not persisted across a
                    reload. Run history keeps a bounded candidate-safe summary
                    and, when allowed, a separately verified replay bundle.
                    Private interviewer runs are excluded from persistent Run
                    history.
                  </p>
                </div>
              </section>
              <section className="evidence-boundary">
                <CheckCircle size={18} />
                <div>
                  <strong>Export privacy scope</strong>
                  <p>
                    {role === "interviewer"
                      ? "Report exports may include the private rubric. Portable replay export remains disabled for any run containing hidden requirements or an interviewer brief."
                      : "Portable replay export cannot include hidden rubric requirements or the interviewer brief."}
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
