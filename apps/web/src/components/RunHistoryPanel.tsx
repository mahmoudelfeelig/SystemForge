import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  FloppyDisk,
  GitDiff,
  MagnifyingGlass,
  Star,
  Trash,
  TrendUp,
  Warning,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  compareLocalRunHistory,
  downloadLocalRunHistoryComparison,
  downloadLocalRunHistoryRecord,
  verifyLocalRunHistoryReplay,
  type LocalRunHistoryMetrics,
  type LocalRunHistoryRecord,
  type LocalRunHistoryStatus,
} from "../lib/runHistory";
import { useLabStore } from "../store/useLabStore";

interface RunHistoryPanelProps {
  onReplay: () => void;
}

const formatDate = (value: string) =>
  new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

const formatNumber = (value: number, digits = 2) =>
  value.toLocaleString("en-US", { maximumFractionDigits: digits });

const formatBytes = (value: number) =>
  value < 1_000_000
    ? `${formatNumber(value / 1_000, 1)} KB`
    : `${formatNumber(value / 1_000_000, 2)} MB`;

const shortDigest = (value: string | undefined) =>
  !value
    ? "—"
    : value.length > 26
      ? `${value.slice(0, 12)}…${value.slice(-8)}`
      : value;

const statusLabels: Record<LocalRunHistoryStatus, string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const replayLabels: Record<LocalRunHistoryRecord["replayState"], string> = {
  available: "Replay ready",
  "not-completed": "No completed output",
  "integrity-unavailable": "Replay digest unavailable",
  "too-large": "Replay exceeded file limit",
  "evicted-for-space": "Replay inputs evicted · summary kept",
};

const metricRows: Array<{
  key: keyof LocalRunHistoryMetrics;
  label: string;
  unit: string;
  lowerIsBetter: boolean;
}> = [
  {
    key: "p95LatencyMs",
    label: "Worst p95 latency",
    unit: " ms",
    lowerIsBetter: true,
  },
  {
    key: "availabilityPercent",
    label: "Average availability",
    unit: "%",
    lowerIsBetter: false,
  },
  {
    key: "errorRatePercent",
    label: "Worst error rate",
    unit: "%",
    lowerIsBetter: true,
  },
  {
    key: "monthlyCostEur",
    label: "Modeled monthly cost",
    unit: " EUR",
    lowerIsBetter: true,
  },
  {
    key: "dataLoss",
    label: "Modeled data loss",
    unit: "",
    lowerIsBetter: true,
  },
  {
    key: "durabilityPercent",
    label: "Minimum durability",
    unit: "%",
    lowerIsBetter: false,
  },
  {
    key: "recoveryTimeSeconds",
    label: "Worst recovery",
    unit: " s",
    lowerIsBetter: true,
  },
  {
    key: "operationalComplexity",
    label: "Operational complexity",
    unit: "",
    lowerIsBetter: true,
  },
];

const deltaTone = (value: number, lowerIsBetter: boolean) => {
  if (Math.abs(value) < 0.000_001) return "neutral";
  return (lowerIsBetter ? value < 0 : value > 0) ? "positive" : "negative";
};

const signed = (value: number, unit: string, digits = 2) =>
  `${value > 0 ? "+" : ""}${formatNumber(value, digits)}${unit}`;

const percentDelta = (value: number) =>
  Number.isFinite(value) ? signed(value, "%", 1) : "n/a";

export function RunHistoryPanel({ onReplay }: RunHistoryPanelProps) {
  const records = useLabStore((state) => state.runHistory);
  const usedBytes = useLabStore((state) => state.runHistoryUsedBytes);
  const maximumBytes = useLabStore((state) => state.runHistoryMaximumBytes);
  const issue = useLabStore((state) => state.runHistoryIssue);
  const updateRecord = useLabStore((state) => state.updateRunHistoryRecord);
  const removeRecord = useLabStore((state) => state.removeRunHistoryRecord);
  const clearHistory = useLabStore((state) => state.clearRunHistory);
  const replayImportedBundle = useLabStore(
    (state) => state.replayImportedBundle,
  );
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | LocalRunHistoryStatus>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [baselineId, setBaselineId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [replayState, setReplayState] = useState<
    "idle" | "verifying" | "error"
  >("idle");
  const [replayError, setReplayError] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("en-US");
    return records.filter((record) => {
      if (status !== "all" && record.status !== status) return false;
      if (!normalized) return true;
      return [
        record.label,
        record.scenario.name,
        record.scenario.id,
        record.architecture.id,
        record.runId,
        record.engineVersion,
        ...record.tags,
      ].some((value) => value.toLocaleLowerCase("en-US").includes(normalized));
    });
  }, [query, records, status]);

  const selected =
    records.find((record) => record.id === selectedId) ?? records[0] ?? null;
  const completed = records.filter(
    (record) => record.status === "completed" && record.metrics,
  );
  const baseline =
    completed.find((record) => record.id === baselineId) ??
    completed.find((record) => record.starred) ??
    completed[0] ??
    null;
  const comparison =
    completed.find((record) => record.id === comparisonId) ??
    completed.find((record) => record.id !== baseline?.id) ??
    null;
  const compared =
    baseline && comparison
      ? compareLocalRunHistory(baseline, comparison)
      : null;
  const trendRecords = useMemo(() => {
    if (!baseline) return [];
    return records
      .filter(
        (record) =>
          record.status === "completed" &&
          record.metrics &&
          record.scenario.id === baseline.scenario.id &&
          record.engineVersion === baseline.engineVersion,
      )
      .sort(
        (left, right) =>
          Date.parse(left.finishedAt) - Date.parse(right.finishedAt),
      )
      .slice(-8);
  }, [baseline, records]);

  useEffect(() => {
    if (!selected && records[0]) setSelectedId(records[0].id);
  }, [records, selected]);

  useEffect(() => {
    if (!selected) return;
    setSelectedId(selected.id);
    setLabel(selected.label);
    setNote(selected.note);
    setTags(selected.tags.join(", "));
    setReplayState("idle");
    setReplayError(null);
  }, [selected]);

  useEffect(() => {
    if (baseline && baseline.id !== baselineId) setBaselineId(baseline.id);
    if (comparison && comparison.id !== comparisonId)
      setComparisonId(comparison.id);
  }, [baseline, baselineId, comparison, comparisonId]);

  const saveMetadata = () => {
    if (!selected) return;
    void updateRecord(selected.id, {
      label,
      note,
      tags: tags.split(","),
    });
  };

  const replaySelected = async () => {
    if (!selected) return;
    setReplayState("verifying");
    setReplayError(null);
    try {
      const bundle = await verifyLocalRunHistoryReplay(selected);
      onReplay();
      await replayImportedBundle(bundle);
    } catch (error) {
      setReplayState("error");
      setReplayError(
        error instanceof Error
          ? error.message
          : "The stored replay bundle could not be verified.",
      );
    }
  };

  return (
    <div
      id="decision-panel-runs"
      className="run-history-workbench"
      role="tabpanel"
      aria-labelledby="decision-tab-runs"
    >
      <aside className="run-library-controls">
        <header>
          <span>Local evidence</span>
          <strong>Run library</strong>
          <p>Completed, failed, and cancelled runs saved in this browser.</p>
        </header>
        <label>
          Search runs
          <span className="run-library-search">
            <MagnifyingGlass size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Scenario, tag, run ID"
            />
          </span>
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as typeof status)}
          >
            <option value="all">All runs</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <dl className="run-library-storage">
          <div>
            <dt>Records</dt>
            <dd>{records.length} / 24</dd>
          </div>
          <div>
            <dt>Local storage</dt>
            <dd>
              {formatBytes(usedBytes)} / {formatBytes(maximumBytes)}
            </dd>
          </div>
          <div>
            <dt>Starred baselines</dt>
            <dd>{records.filter((record) => record.starred).length} / 6</dd>
          </div>
        </dl>
        {issue ? (
          <p className="field-error" role="alert">
            {issue}
          </p>
        ) : null}
        <button
          type="button"
          className="run-library-clear"
          disabled={records.length === 0}
          onClick={() => {
            if (
              window.confirm(
                "Clear every local run summary and stored replay bundle? This cannot be undone.",
              )
            )
              void clearHistory();
          }}
        >
          <Trash size={15} /> Clear history
        </button>
        <section className="run-library-boundary">
          <strong>Stored locally</strong>
          <p>
            Bounded summaries and candidate-safe replay inputs only. Private
            rubrics, interviewer notes, credentials, host tokens, and hidden
            criteria are never copied into Run history. Private interviewer runs
            are excluded. Labels, notes, and tags are local user metadata and
            are omitted from replay and comparison exports.
          </p>
        </section>
      </aside>

      <section className="run-library-list" aria-label="Saved local runs">
        <header>
          <span>Newest first</span>
          <strong>{filtered.length} runs shown</strong>
        </header>
        {filtered.length === 0 ? (
          <div className="candidate-empty">
            <TrendUp size={24} />
            <strong>No matching runs</strong>
            <p>Complete a local run, or change the search and status filter.</p>
          </div>
        ) : (
          <div className="run-library-records">
            {filtered.map((record) => (
              <button
                type="button"
                key={record.id}
                className={record.id === selected?.id ? "active" : ""}
                onClick={() => setSelectedId(record.id)}
                aria-pressed={record.id === selected?.id}
              >
                <span
                  className={`run-record-status run-record-status--${record.status}`}
                >
                  {statusLabels[record.status]}
                </span>
                <strong>{record.label}</strong>
                <small>{formatDate(record.finishedAt)}</small>
                <span className="run-record-meta">
                  <b>{record.engineVersion}</b>
                  <span>seed {record.seed.toLocaleString("en-US")}</span>
                  {record.metrics ? (
                    <span>
                      {record.metrics.objectivesPassed}/
                      {record.metrics.objectivesTotal} objectives
                    </span>
                  ) : null}
                </span>
                {record.starred ? (
                  <Star
                    className="run-record-star"
                    size={15}
                    weight="fill"
                    aria-label="Starred baseline"
                  />
                ) : null}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="run-library-inspector">
        {selected ? (
          <>
            <header className="run-record-heading">
              <div>
                <span>Selected run</span>
                <strong>{selected.label}</strong>
                <small>{selected.runId}</small>
              </div>
              <button
                type="button"
                className={selected.starred ? "active" : ""}
                onClick={() =>
                  void updateRecord(selected.id, {
                    starred: !selected.starred,
                  })
                }
                aria-pressed={selected.starred}
              >
                <Star
                  size={16}
                  weight={selected.starred ? "fill" : "regular"}
                />
                {selected.starred ? "Baseline" : "Star baseline"}
              </button>
            </header>
            <dl className="run-record-summary">
              <div>
                <dt>Status</dt>
                <dd>{statusLabels[selected.status]}</dd>
              </div>
              <div>
                <dt>Scenario</dt>
                <dd>
                  {selected.scenario.name} · rev {selected.scenario.revision}
                </dd>
              </div>
              <div>
                <dt>Topology</dt>
                <dd>
                  {selected.architecture.nodeCount} nodes ·{" "}
                  {selected.architecture.edgeCount} edges
                </dd>
              </div>
              <div>
                <dt>Result digest</dt>
                <dd>{shortDigest(selected.resultDigest?.value)}</dd>
              </div>
              <div>
                <dt>Replay</dt>
                <dd>{replayLabels[selected.replayState]}</dd>
              </div>
              <div>
                <dt>Actions</dt>
                <dd>{selected.actionCount}</dd>
              </div>
              <div>
                <dt>Occurrences</dt>
                <dd>{selected.repeatCount}</dd>
              </div>
            </dl>
            {selected.determinismWarning ? (
              <p className="field-error" role="alert">
                Identical replay inputs produced a different result digest. Keep
                both records and investigate before treating either as a
                baseline.
              </p>
            ) : null}
            {selected.metrics ? (
              <dl className="run-record-metrics">
                <div>
                  <dt>Objectives</dt>
                  <dd>
                    {selected.metrics.objectivesPassed}/
                    {selected.metrics.objectivesTotal}
                  </dd>
                </div>
                <div>
                  <dt>Worst p95</dt>
                  <dd>{formatNumber(selected.metrics.p95LatencyMs)} ms</dd>
                </div>
                <div>
                  <dt>Availability</dt>
                  <dd>
                    {formatNumber(selected.metrics.availabilityPercent, 4)}%
                  </dd>
                </div>
                <div>
                  <dt>Worst error</dt>
                  <dd>{formatNumber(selected.metrics.errorRatePercent, 4)}%</dd>
                </div>
                <div>
                  <dt>Modeled cost</dt>
                  <dd>{formatNumber(selected.metrics.monthlyCostEur)} EUR</dd>
                </div>
              </dl>
            ) : null}
            <div className="run-record-actions">
              <button
                type="button"
                disabled={
                  selected.replayState !== "available" ||
                  replayState === "verifying"
                }
                onClick={() => void replaySelected()}
              >
                <ArrowClockwise size={15} />
                {replayState === "verifying"
                  ? "Checking replay"
                  : "Verify and replay"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setReplayError(null);
                  void downloadLocalRunHistoryRecord(selected).catch((error) =>
                    setReplayError(
                      error instanceof Error
                        ? error.message
                        : "The stored replay bundle could not be exported.",
                    ),
                  );
                }}
              >
                <DownloadSimple size={15} /> Export
              </button>
              <button
                type="button"
                className="danger"
                onClick={() => void removeRecord(selected.id)}
              >
                <Trash size={15} /> Delete
              </button>
            </div>
            {replayError ? (
              <p className="field-error" role="alert">
                {replayError}
              </p>
            ) : null}
            <details className="run-record-edit">
              <summary>Label, notes, and tags</summary>
              <label>
                Run label
                <input
                  maxLength={80}
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                />
              </label>
              <label>
                Notes
                <textarea
                  maxLength={500}
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  placeholder="What changed, and what should this run prove?"
                />
              </label>
              <label>
                Tags
                <input
                  maxLength={160}
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="baseline, cache, region"
                />
              </label>
              <button type="button" onClick={saveMetadata}>
                <FloppyDisk size={15} /> Save details
              </button>
            </details>

            <section className="run-comparison" aria-label="Run comparison">
              <header>
                <GitDiff size={17} />
                <div>
                  <span>Compare runs</span>
                  <strong>Reference against candidate</strong>
                </div>
              </header>
              <div className="run-comparison-selectors">
                <label>
                  Reference
                  <select
                    value={baseline?.id ?? ""}
                    onChange={(event) => setBaselineId(event.target.value)}
                  >
                    {completed.map((record) => (
                      <option value={record.id} key={record.id}>
                        {record.starred ? "★ " : ""}
                        {record.label} · {formatDate(record.finishedAt)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Candidate
                  <select
                    value={comparison?.id ?? ""}
                    onChange={(event) => setComparisonId(event.target.value)}
                  >
                    {completed.map((record) => (
                      <option value={record.id} key={record.id}>
                        {record.label} · {formatDate(record.finishedAt)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {!baseline || !comparison ? (
                <p>Complete at least two runs to compare modeled outcomes.</p>
              ) : !compared?.compatible ? (
                <div className="run-comparison-blocked" role="status">
                  <Warning size={16} />
                  <span>{compared?.issues.join(" ")}</span>
                </div>
              ) : (
                <>
                  <div className="run-comparison-inputs">
                    <span>
                      Inputs{" "}
                      <strong>
                        {compared.sameInputs ? "MATCH" : "DIFFER"}
                      </strong>
                    </span>
                    <span>
                      Seed{" "}
                      <strong>{compared.sameSeed ? "MATCH" : "DIFFER"}</strong>
                    </span>
                    <span>
                      Architecture{" "}
                      <strong>
                        {compared.sameArchitecture ? "MATCH" : "DIFFER"}
                      </strong>
                    </span>
                  </div>
                  <div
                    className="run-comparison-table"
                    role="table"
                    aria-label="Local run summary deltas"
                  >
                    <div role="row" className="run-comparison-head">
                      <span role="columnheader">Measure</span>
                      <span role="columnheader">Reference</span>
                      <span role="columnheader">Candidate</span>
                      <span role="columnheader">Delta</span>
                      <span role="columnheader">Change</span>
                    </div>
                    <div role="row">
                      <strong role="rowheader">Objective pass rate</strong>
                      <span role="cell">
                        {baseline.metrics!.objectivesPassed}/
                        {baseline.metrics!.objectivesTotal} (
                        {percentDelta(
                          baseline.metrics!.objectivesTotal === 0
                            ? 0
                            : (baseline.metrics!.objectivesPassed /
                                baseline.metrics!.objectivesTotal) *
                                100,
                        )}
                        )
                      </span>
                      <span role="cell">
                        {comparison.metrics!.objectivesPassed}/
                        {comparison.metrics!.objectivesTotal} (
                        {percentDelta(
                          comparison.metrics!.objectivesTotal === 0
                            ? 0
                            : (comparison.metrics!.objectivesPassed /
                                comparison.metrics!.objectivesTotal) *
                                100,
                        )}
                        )
                      </span>
                      {compared.objectivesComparable ? (
                        <>
                          <b
                            role="cell"
                            className={deltaTone(
                              compared.objectivePassRateDeltaPercent!,
                              false,
                            )}
                          >
                            {signed(
                              compared.objectivePassRateDeltaPercent!,
                              " pp",
                            )}
                          </b>
                          <span role="cell">Same objective set</span>
                        </>
                      ) : (
                        <>
                          <span role="cell">—</span>
                          <span role="cell">Objective sets differ</span>
                        </>
                      )}
                    </div>
                    {metricRows.map((metric) => (
                      <div role="row" key={metric.key}>
                        <strong role="rowheader">{metric.label}</strong>
                        <span role="cell">
                          {formatNumber(baseline.metrics![metric.key])}
                          {metric.unit}
                        </span>
                        <span role="cell">
                          {formatNumber(comparison.metrics![metric.key])}
                          {metric.unit}
                        </span>
                        <b
                          role="cell"
                          className={deltaTone(
                            compared.metricDeltas![metric.key],
                            metric.lowerIsBetter,
                          )}
                        >
                          {signed(
                            compared.metricDeltas![metric.key],
                            metric.unit,
                          )}
                        </b>
                        <span role="cell">
                          {percentDelta(
                            compared.metricPercentDeltas![metric.key],
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="run-comparison-exports">
                    <button
                      type="button"
                      onClick={() =>
                        downloadLocalRunHistoryComparison(
                          baseline,
                          comparison,
                          "json",
                        )
                      }
                    >
                      <DownloadSimple size={14} /> JSON comparison
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        downloadLocalRunHistoryComparison(
                          baseline,
                          comparison,
                          "markdown",
                        )
                      }
                    >
                      <DownloadSimple size={14} /> Markdown comparison
                    </button>
                  </div>
                </>
              )}
            </section>

            <section className="run-trend" aria-label="Run trend">
              <header>
                <TrendUp size={17} />
                <div>
                  <span>Compatible history</span>
                  <strong>{baseline?.scenario.name ?? "Scenario trend"}</strong>
                </div>
              </header>
              {trendRecords.length < 3 ? (
                <p>
                  Complete three runs of the same scenario and engine to see a
                  trend.
                </p>
              ) : (
                <div className="run-trend-table" role="table">
                  <div role="row">
                    <span role="columnheader">Run</span>
                    <span role="columnheader">Objectives</span>
                    <span role="columnheader">p95</span>
                    <span role="columnheader">Availability</span>
                    <span role="columnheader">Error</span>
                    <span role="columnheader">Cost</span>
                  </div>
                  {trendRecords.map((record) => (
                    <div role="row" key={record.id}>
                      <strong role="rowheader">
                        {new Intl.DateTimeFormat("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        }).format(new Date(record.finishedAt))}
                      </strong>
                      <span role="cell">
                        {record.metrics!.objectivesPassed}/
                        {record.metrics!.objectivesTotal}
                      </span>
                      <span role="cell">
                        {formatNumber(record.metrics!.p95LatencyMs)} ms
                      </span>
                      <span role="cell">
                        {formatNumber(record.metrics!.availabilityPercent, 3)}%
                      </span>
                      <span role="cell">
                        {formatNumber(record.metrics!.errorRatePercent, 3)}%
                      </span>
                      <span role="cell">
                        {formatNumber(record.metrics!.monthlyCostEur, 0)} EUR
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <small>
                Exact stored summaries in chronological order. No series is
                independently normalized.
              </small>
            </section>
          </>
        ) : (
          <div className="candidate-empty">
            <CheckCircle size={24} />
            <strong>No local runs saved</strong>
            <p>
              Complete, cancel, or fail a local run to add its bounded record
              here automatically.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
