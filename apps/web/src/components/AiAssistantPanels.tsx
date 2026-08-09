import { CheckCircle, Lock, Sparkle, Warning } from "@phosphor-icons/react";
import {
  scenarioSchema,
  type AiAssistantCapabilities,
  type AiInterviewTurnResponse,
  type AiRequirementCompileResponse,
  type AiRequirementScope,
  type AiRunDebriefResponse,
  type AiScenarioCompileResponse,
  type Architecture,
  type Requirement,
  type Scenario,
} from "@systemforge/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  compileRequirementsWithAi,
  compileScenarioWithAi,
  conductInterviewWithAi,
  debriefCanonicalRunWithAi,
  fetchAiCapabilities,
} from "../lib/ai";
import { useLabStore } from "../store/useLabStore";

type CapabilityState =
  | { status: "loading"; capabilities: null; message: string }
  | {
      status: "available" | "unavailable";
      capabilities: AiAssistantCapabilities | null;
      message: string;
    };

function useAiCapabilities(): CapabilityState {
  const [state, setState] = useState<CapabilityState>({
    status: "loading",
    capabilities: null,
    message: "Checking the optional assistant…",
  });

  useEffect(() => {
    const controller = new AbortController();
    void fetchAiCapabilities(controller.signal)
      .then((capabilities) => {
        if (!capabilities.enabled) {
          setState({
            status: "unavailable",
            capabilities,
            message:
              "AI assistance is disabled. Manual authoring and deterministic runs remain available.",
          });
          return;
        }
        setState({
          status: "available",
          capabilities,
          message: "AI assistant available",
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "unavailable",
          capabilities: null,
          message:
            error instanceof Error
              ? error.message
              : "Optional AI assistance is unavailable.",
        });
      });
    return () => controller.abort();
  }, []);

  return state;
}

function CapabilityStatus({ state }: { state: CapabilityState }) {
  return (
    <div className={`ai-assistant__status ${state.status}`} role="status">
      {state.status === "available" ? (
        <CheckCircle size={15} />
      ) : state.status === "loading" ? (
        <Sparkle size={15} />
      ) : (
        <Warning size={15} />
      )}
      <span>{state.message}</span>
    </div>
  );
}

function AssistantBoundary() {
  return (
    <footer className="ai-assistant__boundary">
      <Lock size={14} />
      <span>
        Review every suggestion before applying it. Your text is sent to the
        connected AI service and may be handled under that service’s data
        policy.
      </span>
    </footer>
  );
}

type ScenarioPreview =
  | { task: "author-scenario"; response: AiScenarioCompileResponse }
  | {
      task: "compile-requirements";
      response: AiRequirementCompileResponse;
    };

export interface ScenarioAiAssistantProps {
  scenario: Scenario;
  architecture: Architecture;
  mode: "custom" | "interview";
  onApplyScenario: (scenario: Scenario) => void;
  onApplyRequirements: (requirements: Requirement[]) => string | null;
}

export function ScenarioAiAssistant({
  scenario,
  architecture,
  mode,
  onApplyScenario,
  onApplyRequirements,
}: ScenarioAiAssistantProps) {
  const capabilities = useAiCapabilities();
  const [sourceText, setSourceText] = useState("");
  const [task, setTask] = useState<ScenarioPreview["task"]>("author-scenario");
  const [privateObjectives, setPrivateObjectives] = useState(
    mode === "interview",
  );
  const [preview, setPreview] = useState<ScenarioPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPreview(null);
    setError(null);
    setRunning(false);
  }, [architecture, scenario]);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setPreview(null);
    setError(null);
    setRunning(false);
  }, [privateObjectives, sourceText, task]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  const available = capabilities.status === "available";
  const requirementScope: AiRequirementScope =
    mode === "custom"
      ? "custom-public"
      : privateObjectives
        ? "interview-private"
        : "interview-public";

  const requestProposal = async () => {
    const requestSequence = ++sequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setRunning(true);
    setError(null);
    setPreview(null);
    try {
      if (task === "author-scenario") {
        const response = await compileScenarioWithAi(
          {
            sourceText: sourceText.trim(),
            mode,
            baseScenario: scenario,
            architecture,
          },
          controller.signal,
        );
        if (sequence.current === requestSequence)
          setPreview({ task, response });
      } else {
        const response = await compileRequirementsWithAi(
          {
            sourceText: sourceText.trim(),
            scope: requirementScope,
            context: { scenario, architecture },
          },
          controller.signal,
        );
        if (sequence.current === requestSequence)
          setPreview({ task, response });
      }
    } catch (reason) {
      if (controller.signal.aborted || sequence.current !== requestSequence)
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The assistant could not prepare a validated proposal.",
      );
    } finally {
      if (sequence.current === requestSequence) {
        setRunning(false);
        activeRequest.current = null;
      }
    }
  };

  const applyPreview = () => {
    if (!preview) return;
    if (preview.task === "author-scenario") {
      const parsed = scenarioSchema.safeParse(preview.response.scenario);
      if (!parsed.success) {
        setError("The returned scenario no longer passes local validation.");
        return;
      }
      onApplyScenario(parsed.data);
    } else {
      const applyError = onApplyRequirements(preview.response.requirements);
      if (applyError) {
        setError(applyError);
        return;
      }
    }
    setPreview(null);
  };

  const unresolved = preview?.response.unresolvedQuestions ?? [];
  const assumptions = preview?.response.assumptions ?? [];

  return (
    <section
      className="ai-assistant ai-assistant--designer"
      aria-label="AI drafting assistant"
    >
      <header>
        <Sparkle size={18} />
        <div>
          <span>Draft with AI</span>
          <strong>Turn a written brief into a scenario</strong>
          <p>
            SystemForge checks every measurable change against your brief before
            you can apply it.
          </p>
        </div>
        <CapabilityStatus state={capabilities} />
      </header>
      <div className="ai-assistant__controls">
        <label>
          Proposal type
          <select
            value={task}
            onChange={(event) =>
              setTask(event.target.value as ScenarioPreview["task"])
            }
          >
            <option value="author-scenario">Full scenario draft</option>
            <option value="compile-requirements">Objectives only</option>
          </select>
        </label>
        {mode === "interview" && task === "compile-requirements" ? (
          <label>
            Objective visibility
            <select
              value={privateObjectives ? "private" : "public"}
              onChange={(event) =>
                setPrivateObjectives(event.target.value === "private")
              }
            >
              <option value="private">Private rubric</option>
              <option value="public">Candidate-visible</option>
            </select>
          </label>
        ) : null}
        <label className="ai-assistant__brief">
          Written brief
          <textarea
            aria-label="Written brief"
            value={sourceText}
            maxLength={8_000}
            rows={5}
            placeholder="Example: Sustain 12,000 rps for 10 minutes. Keep p95 latency below 300 ms and availability above 99.9%."
            onChange={(event) => setSourceText(event.target.value)}
          />
          <small>{sourceText.length.toLocaleString("en-US")} / 8,000</small>
        </label>
        <button
          className="decision-primary"
          type="button"
          disabled={!available || running || sourceText.trim().length < 8}
          onClick={() => void requestProposal()}
        >
          {running ? "Preparing proposal…" : "Prepare validated proposal"}
        </button>
      </div>
      {error ? (
        <p className="ai-assistant__error" role="alert">
          <Warning size={14} /> {error}
        </p>
      ) : null}
      {preview ? (
        <>
          <span className="visually-hidden" role="status">
            Validated proposal ready for review. It has not been applied.
          </span>
          <section
            className="ai-assistant__preview"
            aria-label="AI proposal preview"
          >
            <header>
              <span>Preview only</span>
              <strong>
                {preview.task === "author-scenario"
                  ? preview.response.scenario.title
                  : `${preview.response.requirements.length} validated objectives`}
              </strong>
            </header>
            {preview.task === "author-scenario" ? (
              <>
                <dl>
                  <div>
                    <dt>Workload</dt>
                    <dd>
                      {preview.response.scenario.workload.baseRps.toLocaleString(
                        "en-US",
                      )}
                      –
                      {preview.response.scenario.workload.peakRps.toLocaleString(
                        "en-US",
                      )}{" "}
                      rps
                    </dd>
                  </div>
                  <div>
                    <dt>Changes</dt>
                    <dd>{preview.response.changes.length}</dd>
                  </div>
                  <div>
                    <dt>Incidents</dt>
                    <dd>{preview.response.scenario.incidents.length}</dd>
                  </div>
                  <div>
                    <dt>Objectives</dt>
                    <dd>{preview.response.scenario.requirements.length}</dd>
                  </div>
                </dl>
                <div className="ai-assistant__scenario-review">
                  <section>
                    <strong>Brief and workload</strong>
                    <dl>
                      <div>
                        <dt>Current summary</dt>
                        <dd>{scenario.summary}</dd>
                      </div>
                      <div>
                        <dt>Proposed summary</dt>
                        <dd>{preview.response.scenario.summary}</dd>
                      </div>
                      {mode === "interview" ? (
                        <>
                          <div>
                            <dt>Current candidate brief</dt>
                            <dd>{scenario.interview?.candidateBrief}</dd>
                          </div>
                          <div>
                            <dt>Proposed candidate brief</dt>
                            <dd>
                              {
                                preview.response.scenario.interview
                                  ?.candidateBrief
                              }
                            </dd>
                          </div>
                        </>
                      ) : null}
                      <div>
                        <dt>Current workload</dt>
                        <dd>
                          {scenario.workload.baseRps.toLocaleString("en-US")}–
                          {scenario.workload.peakRps.toLocaleString("en-US")}{" "}
                          rps for{" "}
                          {scenario.workload.durationSeconds.toLocaleString(
                            "en-US",
                          )}
                          s
                        </dd>
                      </div>
                      <div>
                        <dt>Proposed workload</dt>
                        <dd>
                          {preview.response.scenario.workload.baseRps.toLocaleString(
                            "en-US",
                          )}
                          –
                          {preview.response.scenario.workload.peakRps.toLocaleString(
                            "en-US",
                          )}{" "}
                          rps for{" "}
                          {preview.response.scenario.workload.durationSeconds.toLocaleString(
                            "en-US",
                          )}
                          s
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section>
                    <strong>Scheduled incidents</strong>
                    {preview.response.scenario.incidents.length ? (
                      <ul>
                        {preview.response.scenario.incidents.map((incident) => (
                          <li key={incident.id}>
                            <strong>{incident.label}</strong>
                            <span>
                              {incident.kind} at {incident.atSecond}s
                              {incident.durationSeconds
                                ? ` for ${incident.durationSeconds}s`
                                : ""}
                              {incident.targetId
                                ? ` · target ${incident.targetId}`
                                : incident.region
                                  ? ` · region ${incident.region}`
                                  : incident.zone
                                    ? ` · zone ${incident.zone}`
                                    : ""}
                            </span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p>No incidents in the proposed schedule.</p>
                    )}
                  </section>
                  <section>
                    <strong>Evaluation criteria</strong>
                    {preview.response.scenario.requirements.length ? (
                      <ul>
                        {preview.response.scenario.requirements.map(
                          (requirement) => (
                            <li key={requirement.id}>
                              <strong>{requirement.label}</strong>
                              <span>
                                {requirement.metric} {requirement.operator}{" "}
                                {requirement.target} {requirement.unit} ·{" "}
                                {requirement.visibility}
                              </span>
                            </li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p>No evaluation criteria in the proposed scenario.</p>
                    )}
                  </section>
                </div>
                <div className="ai-assistant__changes">
                  <strong>Proposed field changes</strong>
                  <ul>
                    {preview.response.changes.map((change) => (
                      <li key={`${change.path}-${change.provenance}`}>
                        <code>{change.path}</code>
                        <span>{change.provenance.replaceAll("-", " ")}</span>
                      </li>
                    ))}
                  </ul>
                  <small>
                    The compiler retains unspecified existing incidents and
                    objectives. Review every proposed item above before
                    applying.
                  </small>
                </div>
              </>
            ) : (
              <>
                <p className="ai-assistant__merge-note">
                  These objectives will be merged by ID. Existing public,
                  private, and candidate-derived objectives remain in the
                  scenario.
                </p>
                <ul>
                  {preview.response.requirements.map((requirement) => (
                    <li key={requirement.id}>
                      <strong>{requirement.label}</strong>
                      <span>
                        {requirement.metric} {requirement.operator}{" "}
                        {requirement.target} {requirement.unit}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {unresolved.length ? (
              <div className="ai-assistant__questions">
                <strong>Needs clarification</strong>
                <ul>
                  {unresolved.map((question) => (
                    <li key={question}>{question}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {assumptions.length ? (
              <details>
                <summary>Assistant assumptions</summary>
                <ul>
                  {assumptions.map((assumption) => (
                    <li key={assumption}>{assumption}</li>
                  ))}
                </ul>
              </details>
            ) : null}
            <div className="ai-assistant__preview-actions">
              <button type="button" onClick={() => setPreview(null)}>
                Discard
              </button>
              <button
                className="decision-primary"
                type="button"
                onClick={applyPreview}
              >
                Apply validated proposal
              </button>
            </div>
          </section>
        </>
      ) : null}
      <AssistantBoundary />
    </section>
  );
}

export function RunAiDebriefPanel() {
  const capabilities = useAiCapabilities();
  const canonicalRunId = useLabStore((state) => state.canonicalRunId);
  const canonicalRunStatus = useLabStore((state) => state.canonicalRunStatus);
  const canonicalRunDigest = useLabStore((state) => state.canonicalRunDigest);
  const scenarioRevision = useLabStore((state) => state.scenarioRevision);
  const architectureRevision = useLabStore(
    (state) => state.architectureRevision,
  );
  const role = useLabStore((state) => state.role);
  const sharedScenarioId = useLabStore((state) => state.sharedScenarioId);
  const sharedHostToken = useLabStore((state) => state.sharedHostToken);
  const [focus, setFocus] = useState("");
  const [response, setResponse] = useState<AiRunDebriefResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResponse(null);
    setError(null);
    setRunning(false);
  }, [
    architectureRevision,
    canonicalRunDigest,
    canonicalRunId,
    role,
    scenarioRevision,
    sharedHostToken,
    sharedScenarioId,
  ]);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResponse(null);
    setError(null);
    setRunning(false);
  }, [focus]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  const evidenceById = useMemo(
    () => new Map(response?.evidence.map((item) => [item.id, item]) ?? []),
    [response],
  );
  const eligible =
    capabilities.status === "available" &&
    canonicalRunStatus === "completed" &&
    Boolean(canonicalRunId);

  const runDebrief = async () => {
    if (!canonicalRunId) return;
    const requestSequence = ++sequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const debrief = await debriefCanonicalRunWithAi(
        {
          runId: canonicalRunId,
          ...(focus.trim() ? { focus: focus.trim() } : {}),
        },
        role === "interviewer" && sharedScenarioId
          ? (sharedHostToken ?? undefined)
          : undefined,
        controller.signal,
      );
      if (sequence.current === requestSequence) setResponse(debrief);
    } catch (reason) {
      if (controller.signal.aborted || sequence.current !== requestSequence)
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The assistant could not debrief this canonical run.",
      );
    } finally {
      if (sequence.current === requestSequence) {
        setRunning(false);
        activeRequest.current = null;
      }
    }
  };

  return (
    <section
      className="ai-assistant ai-assistant--debrief"
      aria-label="AI run debrief"
    >
      <header>
        <Sparkle size={18} />
        <div>
          <span>Optional evidence debrief</span>
          <strong>Explain a completed server run</strong>
          <p>
            The service supplies exact modeled facts. Commentary without cited
            evidence is rejected.
          </p>
        </div>
        <CapabilityStatus state={capabilities} />
      </header>
      <div className="ai-assistant__inline-controls">
        <label>
          Focus, optional
          <input
            value={focus}
            maxLength={500}
            placeholder="Dominant failure path and next experiment"
            onChange={(event) => setFocus(event.target.value)}
          />
        </label>
        <button
          className="decision-primary"
          type="button"
          disabled={!eligible || running}
          onClick={() => void runDebrief()}
        >
          {running ? "Building debrief…" : "Debrief canonical run"}
        </button>
      </div>
      {!canonicalRunId || canonicalRunStatus !== "completed" ? (
        <p className="ai-assistant__empty">
          Complete a server-recomputed run before requesting an
          evidence-grounded debrief. Local reports and exports remain available
          above.
        </p>
      ) : null}
      {error ? (
        <p className="ai-assistant__error" role="alert">
          <Warning size={14} /> {error}
        </p>
      ) : null}
      {response ? (
        <section
          className="ai-assistant__debrief-output"
          aria-label="AI debrief output"
          aria-live="polite"
          role="status"
        >
          <header>
            <span>{response.privacyScope} scope</span>
            <strong>{response.headline}</strong>
            <small>
              Engine {response.engineVersion} · digest {response.digest}
            </small>
          </header>
          <ol>
            {response.observations.map((observation, index) => (
              <li key={`${index}-${observation.finding}`}>
                <p>{observation.finding}</p>
                <dl>
                  {observation.evidenceIds.map((evidenceId) => {
                    const item = evidenceById.get(evidenceId);
                    return item ? (
                      <div key={evidenceId}>
                        <dt>{item.label}</dt>
                        <dd>{item.value}</dd>
                      </div>
                    ) : null;
                  })}
                </dl>
              </li>
            ))}
          </ol>
          {response.nextTests.length ? (
            <div className="ai-assistant__questions">
              <strong>Next tests</strong>
              <ul>
                {response.nextTests.map((nextTest) => (
                  <li key={nextTest}>{nextTest}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
      <AssistantBoundary />
    </section>
  );
}

export interface InterviewAiFacilitatorProps {
  candidateNotes: string;
  candidatePhase: string;
  previousQuestions: string[];
  onQuestionGenerated: (question: string) => void;
}

export function InterviewAiFacilitator({
  candidateNotes,
  candidatePhase,
  previousQuestions,
  onQuestionGenerated,
}: InterviewAiFacilitatorProps) {
  const capabilities = useAiCapabilities();
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const scenarioRevision = useLabStore((state) => state.scenarioRevision);
  const architectureRevision = useLabStore(
    (state) => state.architectureRevision,
  );
  const role = useLabStore((state) => state.role);
  const [focus, setFocus] = useState("");
  const [response, setResponse] = useState<AiInterviewTurnResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const sequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResponse(null);
    setError(null);
    setRunning(false);
  }, [architectureRevision, role, scenarioRevision]);

  useEffect(() => {
    sequence.current += 1;
    activeRequest.current?.abort();
    activeRequest.current = null;
    setResponse(null);
    setError(null);
    setRunning(false);
  }, [candidateNotes, candidatePhase, focus]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  const eligible =
    capabilities.status === "available" &&
    scenario.mode === "interview" &&
    role === "interviewer";

  const askNext = async () => {
    const requestSequence = ++sequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setRunning(true);
    setError(null);
    try {
      const next = await conductInterviewWithAi(
        {
          scenario,
          architecture,
          candidateNotes,
          candidatePhase,
          previousQuestions,
          ...(focus.trim() ? { focus: focus.trim() } : {}),
        },
        controller.signal,
      );
      if (sequence.current !== requestSequence) return;
      setResponse(next);
      onQuestionGenerated(next.question);
    } catch (reason) {
      if (controller.signal.aborted || sequence.current !== requestSequence)
        return;
      setError(
        reason instanceof Error
          ? reason.message
          : "The assistant could not prepare the next interview question.",
      );
    } finally {
      if (sequence.current === requestSequence) {
        setRunning(false);
        activeRequest.current = null;
      }
    }
  };

  return (
    <section
      className="ai-assistant ai-assistant--interview"
      aria-label="AI interview facilitator"
    >
      <header>
        <Sparkle size={18} />
        <div>
          <span>Optional interview facilitator</span>
          <strong>Draft the next discovery question</strong>
          <p>
            Uses candidate-visible context only. It does not score the candidate
            or reveal the private rubric.
          </p>
        </div>
        <CapabilityStatus state={capabilities} />
      </header>
      {role === "interviewer" ? (
        <div className="ai-assistant__inline-controls">
          <label>
            Interview focus, optional
            <input
              value={focus}
              maxLength={500}
              placeholder="Clarify recovery and consistency trade-offs"
              onChange={(event) => setFocus(event.target.value)}
            />
          </label>
          <button
            className="decision-primary"
            type="button"
            disabled={!eligible || running}
            onClick={() => void askNext()}
          >
            {running ? "Preparing question…" : "Draft next question"}
          </button>
        </div>
      ) : (
        <p className="ai-assistant__empty">
          Facilitation controls are available only in the confirmed interviewer
          workspace.
        </p>
      )}
      {error ? (
        <p className="ai-assistant__error" role="alert">
          <Warning size={14} /> {error}
        </p>
      ) : null}
      {response ? (
        <blockquote
          className="ai-assistant__question"
          aria-live="polite"
          role="status"
        >
          <span>Suggested question</span>
          <strong>{response.question}</strong>
          <p>{response.purpose}</p>
          <small>Facilitation prompt only · no candidate score</small>
        </blockquote>
      ) : null}
      <AssistantBoundary />
    </section>
  );
}
