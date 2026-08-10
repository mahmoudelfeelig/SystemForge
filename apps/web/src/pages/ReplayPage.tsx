import {
  ArrowLeft,
  ArrowRight,
  CheckCircle,
  Cpu,
  FileArrowUp,
  Fingerprint,
  GitBranch,
  LockKey,
  ShieldCheck,
  Warning,
  XCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { BrandIcon } from "../components/BrandIcon";
import {
  assessCompletedRunReplayCompatibility,
  compareCompletedRunReplayBundles,
  MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES,
  readCompletedRunReplayBundleFile,
  type CompletedRunReplayBundle,
  type CompletedRunReplayBundleComparison,
  type CompletedRunReplayCompatibility,
} from "../lib/replayBundle";
import {
  ReplayComparisonCancelledError,
  startSynchronizedReplayComparison,
  type ReplayComparisonSession,
  type SynchronizedReplayComparisonResult,
} from "../lib/replayComparison";
import { useLabStore } from "../store/useLabStore";

type FileState = "idle" | "reading" | "ready" | "error";

interface LoadedReplayFile {
  fileName: string;
  fileSize: number;
  bundle: CompletedRunReplayBundle;
  compatibility: CompletedRunReplayCompatibility;
}

const displayBytes = (bytes: number) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);

const profileSummary = (bundle: CompletedRunReplayBundle) => {
  const resolved = bundle.modelEvidence.behavioralProfiles.filter(
    (entry) => entry.status === "resolved",
  ).length;
  return {
    resolved,
    unprofiled: bundle.modelEvidence.behavioralProfiles.length - resolved,
  };
};

const shortDigest = (value: string) =>
  value.length > 28 ? `${value.slice(0, 14)}…${value.slice(-10)}` : value;

const signed = (value: number, digits = 2) =>
  `${value > 0 ? "+" : ""}${value.toLocaleString("en-US", {
    maximumFractionDigits: digits,
  })}`;

export function ReplayPage() {
  const navigate = useNavigate();
  const queueImportedReplay = useLabStore((state) => state.queueImportedReplay);
  const [fileState, setFileState] = useState<FileState>("idle");
  const [loaded, setLoaded] = useState<LoadedReplayFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comparisonState, setComparisonState] = useState<FileState>("idle");
  const [comparisonFileName, setComparisonFileName] = useState<string | null>(
    null,
  );
  const [comparisonLoaded, setComparisonLoaded] =
    useState<LoadedReplayFile | null>(null);
  const [comparison, setComparison] =
    useState<CompletedRunReplayBundleComparison | null>(null);
  const [comparisonError, setComparisonError] = useState<string | null>(null);
  const [outputComparisonState, setOutputComparisonState] = useState<
    "idle" | "running" | "complete" | "error"
  >("idle");
  const [outputComparisonProgress, setOutputComparisonProgress] = useState(0);
  const [outputComparison, setOutputComparison] =
    useState<SynchronizedReplayComparisonResult | null>(null);
  const [outputComparisonError, setOutputComparisonError] = useState<
    string | null
  >(null);
  const sourceReadSequence = useRef(0);
  const comparisonReadSequence = useRef(0);
  const comparisonRunSequence = useRef(0);
  const activeComparison = useRef<ReplayComparisonSession | null>(null);

  const cancelOutputComparison = () => {
    const session = activeComparison.current;
    activeComparison.current = null;
    session?.cancel();
  };

  useEffect(
    () => () => {
      activeComparison.current?.cancel();
      activeComparison.current = null;
    },
    [],
  );

  const selectSourceFile = async (file: File) => {
    const sequence = ++sourceReadSequence.current;
    comparisonReadSequence.current += 1;
    cancelOutputComparison();
    setFileState("reading");
    setLoaded(null);
    setError(null);
    setComparisonState("idle");
    setComparisonFileName(null);
    setComparisonLoaded(null);
    setComparison(null);
    setComparisonError(null);
    setOutputComparisonState("idle");
    setOutputComparisonProgress(0);
    setOutputComparison(null);
    setOutputComparisonError(null);
    try {
      const bundle = await readCompletedRunReplayBundleFile(file);
      if (sequence !== sourceReadSequence.current) return;
      setLoaded({
        fileName: file.name,
        fileSize: file.size,
        bundle,
        compatibility: assessCompletedRunReplayCompatibility(bundle),
      });
      setFileState("ready");
    } catch (reason) {
      if (sequence !== sourceReadSequence.current) return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The selected replay bundle could not be opened.",
      );
      setFileState("error");
    }
  };

  const selectComparisonFile = async (file: File) => {
    if (!loaded) return;
    const sequence = ++comparisonReadSequence.current;
    cancelOutputComparison();
    setComparisonState("reading");
    setComparisonFileName(file.name);
    setComparisonLoaded(null);
    setComparison(null);
    setComparisonError(null);
    setOutputComparisonState("idle");
    setOutputComparisonProgress(0);
    setOutputComparison(null);
    setOutputComparisonError(null);
    try {
      const bundle = await readCompletedRunReplayBundleFile(file);
      if (sequence !== comparisonReadSequence.current || !loaded) return;
      setComparisonLoaded({
        fileName: file.name,
        fileSize: file.size,
        bundle,
        compatibility: assessCompletedRunReplayCompatibility(bundle),
      });
      setComparison(compareCompletedRunReplayBundles(loaded.bundle, bundle));
      setComparisonState("ready");
    } catch (reason) {
      if (sequence !== comparisonReadSequence.current) return;
      setComparisonError(
        reason instanceof Error
          ? reason.message
          : "The comparison bundle could not be opened.",
      );
      setComparisonState("error");
    }
  };

  const startReplay = () => {
    if (!loaded?.compatibility.compatible) return;
    const importedReplayIntent = queueImportedReplay(loaded.bundle);
    void navigate("/lab", { state: { importedReplayIntent } });
  };

  const startOutputComparison = () => {
    if (
      !loaded?.compatibility.compatible ||
      !comparisonLoaded?.compatibility.compatible
    )
      return;
    cancelOutputComparison();
    setOutputComparisonState("running");
    setOutputComparisonProgress(0);
    setOutputComparison(null);
    setOutputComparisonError(null);
    const requestId = `replay-compare-${Date.now().toString(36)}-${++comparisonRunSequence.current}`;
    const session = startSynchronizedReplayComparison(
      loaded.bundle,
      comparisonLoaded.bundle,
      {
        requestId,
        onProgress: ({ progress }) => {
          if (activeComparison.current?.requestId === requestId)
            setOutputComparisonProgress(progress);
        },
      },
    );
    activeComparison.current = session;
    void session.result.then(
      (result) => {
        if (activeComparison.current !== session) return;
        activeComparison.current = null;
        setOutputComparison(result);
        setOutputComparisonProgress(1);
        setOutputComparisonState("complete");
      },
      (reason: unknown) => {
        if (activeComparison.current !== session) return;
        activeComparison.current = null;
        if (reason instanceof ReplayComparisonCancelledError) return;
        setOutputComparisonError(
          reason instanceof Error
            ? reason.message
            : "The synchronized replay comparison failed.",
        );
        setOutputComparisonState("error");
      },
    );
  };

  const profiles = loaded ? profileSummary(loaded.bundle) : null;
  const canReplay = loaded?.compatibility.compatible === true;
  const canCompareOutputs =
    canReplay && comparisonLoaded?.compatibility.compatible === true;
  const fileCheckStatus = error
    ? "REJECTED"
    : fileState === "reading"
      ? "CHECKING"
      : loaded
        ? canReplay
          ? "CHECKS PASSED"
          : "INCOMPATIBLE"
        : "WAITING";
  const outputComparisonAnnouncement =
    outputComparisonState === "running"
      ? `Replay comparison running. ${Math.round(outputComparisonProgress * 100)} percent complete.`
      : outputComparisonState === "complete" && outputComparison
        ? `Replay comparison complete. Source replay digest ${outputComparison.source.resultDigestMatched ? "matched" : "did not match"}. Comparison replay digest ${outputComparison.comparison.resultDigestMatched ? "matched" : "did not match"}.`
        : outputComparisonState === "error" && outputComparisonError
          ? `Replay comparison failed. ${outputComparisonError}`
          : "";
  const outputMetricRows = outputComparison
    ? [
        {
          label: "Objective pass rate",
          source: `${outputComparison.metrics.objectivePassRatePercentage.source.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`,
          comparison: `${outputComparison.metrics.objectivePassRatePercentage.comparison.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`,
          delta: `${signed(outputComparison.metrics.objectivePassRatePercentage.delta, 1)} pp`,
        },
        {
          label: "Worst p95 latency",
          source: `${outputComparison.metrics.p95LatencyMs.source.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`,
          comparison: `${outputComparison.metrics.p95LatencyMs.comparison.toLocaleString("en-US", { maximumFractionDigits: 1 })} ms`,
          delta: `${signed(outputComparison.metrics.p95LatencyMs.delta, 1)} ms`,
        },
        {
          label: "Worst error rate",
          source: `${outputComparison.metrics.errorRatePercentagePoints.source.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`,
          comparison: `${outputComparison.metrics.errorRatePercentagePoints.comparison.toLocaleString("en-US", { maximumFractionDigits: 2 })}%`,
          delta: `${signed(outputComparison.metrics.errorRatePercentagePoints.delta, 2)} pp`,
        },
        {
          label: "Minimum availability",
          source: `${outputComparison.metrics.availabilityPercentagePoints.source.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`,
          comparison: `${outputComparison.metrics.availabilityPercentagePoints.comparison.toLocaleString("en-US", { maximumFractionDigits: 3 })}%`,
          delta: `${signed(outputComparison.metrics.availabilityPercentagePoints.delta, 3)} pp`,
        },
        {
          label: "Maximum monthly cost",
          source: `EUR ${outputComparison.metrics.monthlyCostEur.source.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          comparison: `EUR ${outputComparison.metrics.monthlyCostEur.comparison.toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
          delta: `EUR ${signed(outputComparison.metrics.monthlyCostEur.delta, 0)}`,
        },
      ]
    : [];

  return (
    <div className="replay-console">
      <header className="replay-console__header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <BrandIcon />
          <strong>SystemForge Lab</strong>
          <small>Replay console</small>
        </Link>
        <div className="replay-console__header-state">
          <span>
            <i /> Files stay local
          </span>
          <Link className="button" to="/lab">
            Open current Lab <ArrowRight size={15} />
          </Link>
        </div>
      </header>

      <main className="replay-console__main">
        <aside className="replay-console__rail" aria-label="Replay steps">
          <span className="panel-index">Replay steps</span>
          <ol>
            <li className={fileState === "idle" ? "active" : "complete"}>
              <span>01</span>
              <div>
                <strong>Choose file</strong>
                <small>JSON, up to 2 MB</small>
              </div>
            </li>
            <li
              className={
                fileState === "reading"
                  ? "active"
                  : loaded
                    ? loaded.compatibility.compatible
                      ? "complete"
                      : "failed"
                    : "idle"
              }
            >
              <span>02</span>
              <div>
                <strong>Check file</strong>
                <small>Schema, digest, engine, profiles</small>
              </div>
            </li>
            <li className={canReplay ? "active" : "idle"}>
              <span>03</span>
              <div>
                <strong>Run again</strong>
                <small>Start at second 0</small>
              </div>
            </li>
            <li
              className={
                outputComparisonState === "running"
                  ? "active"
                  : outputComparisonState === "complete"
                    ? outputComparison?.verified
                      ? "complete"
                      : "failed"
                    : outputComparisonState === "error"
                      ? "failed"
                      : "idle"
              }
            >
              <span>04</span>
              <div>
                <strong>Match result</strong>
                <small>Check the source digest</small>
              </div>
            </li>
          </ol>
          <Link to="/">
            <ArrowLeft size={14} /> Return home
          </Link>
        </aside>

        <div className="replay-console__workspace">
          <section className="replay-intake" aria-labelledby="replay-title">
            <header>
              <div>
                <span className="panel-index">Completed run</span>
                <h1 id="replay-title">Verify and replay a run</h1>
                <p>
                  Open a replay bundle. SystemForge verifies it, then reruns the
                  captured inputs locally.
                </p>
              </div>
              <span className="replay-intake__limit">
                JSON · {displayBytes(MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES)} MB
                maximum
              </span>
            </header>

            <label className={`replay-dropzone replay-dropzone--${fileState}`}>
              <input
                type="file"
                accept=".json,application/json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void selectSourceFile(file);
                }}
              />
              <FileArrowUp size={30} weight="duotone" />
              <div>
                <strong>
                  {fileState === "reading"
                    ? "Verifying replay bundle"
                    : loaded
                      ? loaded.fileName
                      : "Choose a replay bundle"}
                </strong>
                <span>JSON, up to 2 MB. The file is not uploaded.</span>
              </div>
              <b>{fileState === "reading" ? "Checking" : "Choose file"}</b>
            </label>

            <div className="replay-intake__message" aria-live="polite">
              {error ? (
                <div className="replay-verdict replay-verdict--failed">
                  <XCircle size={19} weight="fill" />
                  <div>
                    <strong>Bundle rejected</strong>
                    <p>{error}</p>
                  </div>
                </div>
              ) : loaded ? (
                <div
                  className={`replay-verdict replay-verdict--${canReplay ? "ready" : "failed"}`}
                >
                  {canReplay ? (
                    <CheckCircle size={19} weight="fill" />
                  ) : (
                    <XCircle size={19} weight="fill" />
                  )}
                  <div>
                    <strong>
                      {canReplay
                        ? "Bundle checks passed for this model build"
                        : "Bundle is not compatible with this model build"}
                    </strong>
                    {canReplay ? (
                      <p>
                        Internal SHA-256 checks, engine version, and resolved
                        behavioral-profile evidence match. These checks detect
                        accidental file changes; they do not identify or
                        authenticate the file author.
                      </p>
                    ) : (
                      loaded.compatibility.issues.map((issue) => (
                        <p key={issue}>{issue}</p>
                      ))
                    )}
                  </div>
                </div>
              ) : null}
            </div>

            {loaded && profiles ? (
              <div className="replay-source-grid">
                <section>
                  <header>
                    <Fingerprint size={17} />
                    <span>Source</span>
                  </header>
                  <dl>
                    <div>
                      <dt>Run</dt>
                      <dd>{loaded.bundle.source.runId}</dd>
                    </div>
                    <div>
                      <dt>Engine</dt>
                      <dd>{loaded.bundle.source.engineVersion}</dd>
                    </div>
                    <div>
                      <dt>Seed</dt>
                      <dd>
                        {loaded.bundle.source.seed.toLocaleString("en-US")}
                      </dd>
                    </div>
                    <div>
                      <dt>Source result</dt>
                      <dd title={loaded.bundle.source.resultDigest.value}>
                        {shortDigest(loaded.bundle.source.resultDigest.value)}
                      </dd>
                    </div>
                  </dl>
                </section>
                <section>
                  <header>
                    <Cpu size={17} />
                    <span>Captured inputs</span>
                  </header>
                  <dl>
                    <div>
                      <dt>Scenario</dt>
                      <dd>{loaded.bundle.inputs.scenario.title}</dd>
                    </div>
                    <div>
                      <dt>Topology</dt>
                      <dd>
                        {loaded.bundle.inputs.architecture.nodes.length} nodes ·{" "}
                        {loaded.bundle.inputs.architecture.edges.length} edges
                      </dd>
                    </div>
                    <div>
                      <dt>Scheduled actions</dt>
                      <dd>{loaded.bundle.inputs.actionSchedule.length}</dd>
                    </div>
                    <div>
                      <dt>Source profiles</dt>
                      <dd>
                        {profiles.resolved} resolved · {profiles.unprofiled}{" "}
                        unprofiled
                      </dd>
                    </div>
                  </dl>
                </section>
              </div>
            ) : null}

            <button
              type="button"
              className="button button--primary replay-start"
              disabled={!canReplay}
              onClick={startReplay}
            >
              <Cpu size={17} weight="duotone" />
              Verify and replay
              <ArrowRight size={15} />
            </button>
          </section>

          <div
            id="replay-comparison-status"
            className="visually-hidden"
            role="status"
            aria-label="Replay comparison status"
            aria-live="polite"
            aria-atomic="true"
          >
            {outputComparisonAnnouncement}
          </div>
          {loaded?.compatibility.compatible ? (
            <section
              className="replay-comparison"
              aria-labelledby="replay-comparison-title"
              aria-describedby="replay-comparison-status"
              aria-busy={outputComparisonState === "running"}
            >
              <header>
                <div>
                  <span className="panel-index">Run comparison</span>
                  <h2 id="replay-comparison-title">Compare two runs</h2>
                </div>
                <GitBranch size={22} weight="duotone" />
              </header>
              <p>
                Load a second bundle to compare inputs and recomputed results at
                the same modeled second.
              </p>
              <label
                className={`replay-compare-input ${!loaded ? "disabled" : ""}`}
              >
                <input
                  type="file"
                  accept=".json,application/json"
                  disabled={!loaded}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void selectComparisonFile(file);
                  }}
                />
                <FileArrowUp size={18} />
                <span>
                  {comparisonState === "reading"
                    ? "Verifying comparison bundle"
                    : (comparisonFileName ?? "Select comparison bundle")}
                </span>
              </label>
              {comparisonError ? (
                <div className="replay-comparison__error" role="alert">
                  <Warning size={17} /> {comparisonError}
                </div>
              ) : comparison ? (
                <div className="replay-comparison__results">
                  <div
                    className={comparison.inputDigestMatched ? "match" : "diff"}
                  >
                    {comparison.inputDigestMatched ? (
                      <CheckCircle size={17} weight="fill" />
                    ) : (
                      <XCircle size={17} weight="fill" />
                    )}
                    <span>Scenario + architecture digest</span>
                    <strong>
                      {comparison.inputDigestMatched ? "MATCH" : "DIFFER"}
                    </strong>
                  </div>
                  <div
                    className={
                      comparison.actionScheduleMatched ? "match" : "diff"
                    }
                  >
                    {comparison.actionScheduleMatched ? (
                      <CheckCircle size={17} weight="fill" />
                    ) : (
                      <XCircle size={17} weight="fill" />
                    )}
                    <span>Complete action schedule</span>
                    <strong>
                      {comparison.actionScheduleMatched ? "MATCH" : "DIFFER"}
                    </strong>
                  </div>
                  <small>
                    Source {comparison.sourceRunId} · comparison{" "}
                    {comparison.comparisonRunId}. This preflight compares inputs
                    and actions only.
                  </small>
                </div>
              ) : null}
              {comparisonLoaded &&
              !comparisonLoaded.compatibility.compatible ? (
                <div className="replay-comparison__error" role="alert">
                  <Warning size={17} />
                  <span>
                    Output comparison is blocked.{" "}
                    {comparisonLoaded.compatibility.issues.join(" ")}
                  </span>
                </div>
              ) : null}
              <button
                type="button"
                className="button replay-compare-run"
                disabled={
                  !canCompareOutputs || outputComparisonState === "running"
                }
                onClick={startOutputComparison}
              >
                <GitBranch size={17} weight="duotone" />
                {outputComparisonState === "running"
                  ? `Recomputing branches · ${Math.round(outputComparisonProgress * 100)}%`
                  : "Run comparison"}
              </button>
              {outputComparisonError ? (
                <div className="replay-comparison__error" role="alert">
                  <Warning size={17} /> {outputComparisonError}
                </div>
              ) : outputComparison ? (
                <section
                  className={`replay-output ${outputComparison.verified ? "verified" : "unverified"}`}
                  aria-label="Synchronized modeled-output comparison"
                >
                  <header>
                    {outputComparison.verified ? (
                      <CheckCircle size={18} weight="fill" />
                    ) : (
                      <XCircle size={18} weight="fill" />
                    )}
                    <div>
                      <strong>
                        {outputComparison.verified
                          ? "Both recomputations match their source digests"
                          : "One or both source-result digests did not match"}
                      </strong>
                      <span>
                        {outputComparison.timeline.alignedFrameCount} frames
                        aligned from second{" "}
                        {outputComparison.timeline.firstModeledSecond} through{" "}
                        {outputComparison.timeline.lastModeledSecond}
                      </span>
                    </div>
                  </header>
                  <div className="replay-output__digests">
                    <div>
                      <span>Source replay</span>
                      <strong>
                        {outputComparison.source.resultDigestMatched
                          ? "DIGEST MATCH"
                          : "DIGEST MISMATCH"}
                      </strong>
                    </div>
                    <div>
                      <span>Comparison replay</span>
                      <strong>
                        {outputComparison.comparison.resultDigestMatched
                          ? "DIGEST MATCH"
                          : "DIGEST MISMATCH"}
                      </strong>
                    </div>
                  </div>
                  <div
                    className="replay-output__metrics"
                    role="table"
                    aria-label="Aligned modeled metric deltas"
                  >
                    <div role="row" className="replay-output__metric-head">
                      <span role="columnheader">Measure</span>
                      <span role="columnheader">Source</span>
                      <span role="columnheader">Comparison</span>
                      <span role="columnheader">Delta</span>
                    </div>
                    {outputMetricRows.map((metric) => (
                      <div role="row" key={metric.label}>
                        <strong role="rowheader">{metric.label}</strong>
                        <span role="cell">{metric.source}</span>
                        <span role="cell">{metric.comparison}</span>
                        <b role="cell">{metric.delta}</b>
                      </div>
                    ))}
                  </div>
                  <footer>
                    Two fresh deterministic recomputations, aligned by modeled
                    second. No queues, requests, memory, or other opaque runtime
                    state were restored; no production telemetry was compared.
                  </footer>
                </section>
              ) : null}
            </section>
          ) : null}
        </div>

        <aside className="replay-console__boundary">
          <span className="panel-index">File checks</span>
          <header>
            <ShieldCheck size={20} weight="duotone" />
            <div>
              <strong>Replay bundle</strong>
              <span className={canReplay ? "verified" : undefined}>
                {fileCheckStatus}
              </span>
            </div>
          </header>
          {loaded ? (
            <dl>
              <div>
                <dt>Size</dt>
                <dd>{displayBytes(loaded.fileSize)} MB</dd>
              </div>
              <div>
                <dt>Schema</dt>
                <dd>Valid</dd>
              </div>
              <div>
                <dt>Digest</dt>
                <dd>{canReplay ? "Match" : "Check failed"}</dd>
              </div>
              <div>
                <dt>Engine</dt>
                <dd>
                  {canReplay
                    ? loaded.bundle.source.engineVersion
                    : "Incompatible"}
                </dd>
              </div>
              <div>
                <dt>Profiles</dt>
                <dd>
                  {profiles ? `${profiles.resolved} resolved` : "Unavailable"}
                </dd>
              </div>
              <div>
                <dt>Privacy</dt>
                <dd>{canReplay ? "Candidate-safe" : "Rejected"}</dd>
              </div>
            </dl>
          ) : (
            <div className="replay-checks-idle">
              <strong>Checks start after file selection</strong>
              <p>
                SystemForge will check the size, schema, digest, engine,
                behavioral profiles, and privacy boundary locally.
              </p>
              <span>
                Maximum {displayBytes(MAX_COMPLETED_RUN_REPLAY_BUNDLE_BYTES)} MB
              </span>
            </div>
          )}
          <footer>
            <LockKey size={17} weight="duotone" />
            <p>
              Replays recompute from second 0. They do not restore in-flight
              runtime state.
            </p>
          </footer>
        </aside>
      </main>
    </div>
  );
}
