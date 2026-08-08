import {
  ArrowLeft,
  ArrowRight,
  CaretDown,
  Check,
  CloudArrowUp,
  Copy,
  EyeSlash,
  Plus,
  ShieldCheck,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import {
  INCIDENT_KINDS,
  METRIC_NAMES,
  scenarioSchema,
  type Incident,
  type Requirement,
  type Scenario,
} from "@systemforge/contracts";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { BrandIcon } from "../components/BrandIcon";
import { shareScenario } from "../lib/api";
import { encodeLocalShare, interviewShareLinks } from "../lib/share";
import { useLabStore } from "../store/useLabStore";

interface ScenarioDesignerPageProps {
  mode: "custom" | "interview";
}

type RequestProfile = NonNullable<Scenario["workload"]["requestMix"]>[number];
type RegionProfile = Scenario["workload"]["regions"][number];
type DesignerSectionId =
  | "brief"
  | "facilitation"
  | "demand"
  | "requests"
  | "regions"
  | "invariants"
  | "failures"
  | "objectives"
  | "share";

const titleCase = (value: string) =>
  value
    .replaceAll(/([A-Z])/g, " $1")
    .replaceAll("-", " ")
    .replace(/^./, (character) => character.toUpperCase());

const requirementTemplate = (
  index: number,
  mode: ScenarioDesignerPageProps["mode"],
): Requirement => ({
  id: `requirement-${Date.now()}-${index}`,
  label: "p99 latency at or below 400 ms",
  metric: "p99LatencyMs",
  operator: "lte",
  target: 400,
  unit: "ms",
  visibility: mode === "interview" ? "hidden" : "public",
  owner: mode === "interview" ? "interviewer" : "scenario",
});

const incidentTemplate = (index: number): Incident => ({
  id: `incident-${Date.now()}-${index}`,
  atSecond: 30,
  kind: "traffic-spike",
  magnitude: 2,
  durationSeconds: 20,
  label: "Traffic pressure begins",
});

const requestTemplate = (index: number): RequestProfile => ({
  name: `Request class ${index + 1}`,
  share: 0,
  readRatio: 0.5,
  payloadKb: 8,
  computeMs: 5,
  databaseQueries: 1,
  cacheable: false,
  critical: false,
});

const formatShare = (value: number) => `${Math.round(value * 100)}%`;

export function ScenarioDesignerPage({ mode }: ScenarioDesignerPageProps) {
  const navigate = useNavigate();
  const loadSharedScenario = useLabStore((state) => state.loadSharedScenario);
  const [scenario, setDraft] = useState<Scenario>(() => ({
    ...structuredClone(DEFAULT_SCENARIO),
    id: `${mode}-${Date.now()}`,
    title:
      mode === "interview"
        ? "Global ordering system interview"
        : "Untitled systems challenge",
    summary:
      mode === "interview"
        ? "The candidate should discover durability, regional, consistency, and overload constraints before committing to an architecture."
        : "Model a workload, define the invariants that matter, then schedule the failures the architecture must survive.",
    mode,
    requirements:
      mode === "interview"
        ? [requirementTemplate(0, mode)]
        : structuredClone(DEFAULT_SCENARIO.requirements),
    interview:
      mode === "interview"
        ? {
            candidateBrief:
              "Design the backend for a global ordering product. Ask questions before choosing an architecture.",
            interviewerBrief:
              "Evaluate whether the candidate discovers durability, consistency, regional data, recovery, and overload constraints.",
            timeboxMinutes: 45,
            allowCandidateRequirements: true,
            revealPolicy: "interviewer-controlled",
          }
        : undefined,
  }));
  const [copied, setCopied] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [publishError, setPublishError] = useState<string | null>(null);
  const [canonicalLinks, setCanonicalLinks] = useState<{
    participant: string;
    interviewer?: string;
  } | null>(null);
  const [collapsedSections, setCollapsedSections] = useState<
    Set<DesignerSectionId>
  >(new Set());
  const validation = useMemo(
    () => scenarioSchema.safeParse(scenario),
    [scenario],
  );
  const validationMessage = validation.success
    ? null
    : `${validation.error.issues[0]?.path.join(".") || "scenario"}: ${validation.error.issues[0]?.message ?? "The scenario contract is invalid."}`;

  const links = useMemo(
    () =>
      mode === "interview"
        ? interviewShareLinks(scenario, DEFAULT_ARCHITECTURE)
        : null,
    [mode, scenario],
  );
  const regionalShare = scenario.workload.regions.reduce(
    (total, region) => total + region.trafficShare,
    0,
  );
  const requestShare = (scenario.workload.requestMix ?? []).reduce(
    (total, request) => total + request.share,
    0,
  );
  const sectionStates = useMemo(
    () => [
      {
        id: "brief" as const,
        label: "Brief",
        complete:
          scenario.title.trim().length > 2 &&
          scenario.summary.trim().length > 20,
      },
      ...(mode === "interview"
        ? [
            {
              id: "facilitation" as const,
              label: "Facilitation",
              complete:
                Boolean(scenario.interview?.candidateBrief.trim()) &&
                Boolean(scenario.interview?.interviewerBrief.trim()),
            },
          ]
        : []),
      {
        id: "demand" as const,
        label: "Demand",
        complete:
          scenario.workload.baseRps > 0 &&
          scenario.workload.peakRps >= scenario.workload.baseRps &&
          scenario.workload.durationSeconds >= 15,
      },
      {
        id: "requests" as const,
        label: "Request mix",
        complete:
          (scenario.workload.requestMix?.length ?? 0) > 0 &&
          Math.abs(requestShare - 1) < 0.001,
      },
      {
        id: "regions" as const,
        label: "Regions",
        complete:
          scenario.workload.regions.length > 0 &&
          Math.abs(regionalShare - 1) < 0.001,
      },
      {
        id: "invariants" as const,
        label: "Invariants",
        complete: Boolean(
          scenario.domain?.acknowledgedWritesMustSurvive ||
          scenario.domain?.preventOversell ||
          scenario.domain?.piiRegion ||
          scenario.domain?.maximumRecoverySeconds !== undefined,
        ),
      },
      {
        id: "failures" as const,
        label: "Failures",
        complete: scenario.incidents.length > 0,
      },
      {
        id: "objectives" as const,
        label: "Objectives",
        complete: scenario.requirements.length > 0,
      },
      {
        id: "share" as const,
        label: "Handoff",
        complete: validation.success,
      },
    ],
    [mode, regionalShare, requestShare, scenario, validation.success],
  );
  const completedSections = sectionStates.filter(
    (section) => section.complete,
  ).length;
  const nextIncomplete = sectionStates.find((section) => !section.complete);
  const toggleSection = (id: DesignerSectionId) =>
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sectionCollapse = (id: DesignerSectionId) => (
    <button
      className="section-collapse"
      type="button"
      aria-expanded={!collapsedSections.has(id)}
      aria-label={`${collapsedSections.has(id) ? "Expand" : "Collapse"} ${sectionStates.find((section) => section.id === id)?.label ?? id} section`}
      onClick={() => toggleSection(id)}
    >
      <CaretDown size={15} />
    </button>
  );

  const updateWorkload = (patch: Partial<Scenario["workload"]>) =>
    setDraft((current) => ({
      ...current,
      workload: { ...current.workload, ...patch },
    }));
  const updateRequirement = (id: string, patch: Partial<Requirement>) =>
    setDraft((current) => ({
      ...current,
      requirements: current.requirements.map((requirement) =>
        requirement.id === id ? { ...requirement, ...patch } : requirement,
      ),
    }));
  const updateIncident = (id: string, patch: Partial<Incident>) =>
    setDraft((current) => ({
      ...current,
      incidents: current.incidents.map((incident) =>
        incident.id === id ? { ...incident, ...patch } : incident,
      ),
    }));
  const updateRegion = (index: number, patch: Partial<RegionProfile>) =>
    updateWorkload({
      regions: scenario.workload.regions.map((region, currentIndex) =>
        currentIndex === index ? { ...region, ...patch } : region,
      ),
    });
  const updateRequest = (index: number, patch: Partial<RequestProfile>) =>
    updateWorkload({
      requestMix: (scenario.workload.requestMix ?? []).map(
        (request, currentIndex) =>
          currentIndex === index ? { ...request, ...patch } : request,
      ),
    });
  const updateDomain = (patch: NonNullable<Scenario["domain"]>) =>
    setDraft((current) => ({
      ...current,
      domain: { ...current.domain, ...patch },
    }));
  const copy = async (label: string, value: string) => {
    if (!validation.success) return;
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };
  const openLab = () => {
    if (!validation.success) return;
    loadSharedScenario(
      validation.data,
      structuredClone(DEFAULT_ARCHITECTURE),
      mode === "interview" ? "interviewer" : "participant",
    );
    void navigate("/lab");
  };
  const customLink = `${window.location.origin}/lab#share=${encodeLocalShare({ scenario, architecture: DEFAULT_ARCHITECTURE, role: "participant" })}`;
  const publish = async () => {
    if (!validation.success) {
      setPublishError(validationMessage);
      return;
    }
    setPublishing(true);
    setPublishError(null);
    try {
      const receipt = await shareScenario(
        validation.data,
        DEFAULT_ARCHITECTURE,
      );
      setCanonicalLinks({
        participant: receipt.candidateUrl ?? receipt.url,
        ...(receipt.interviewerUrl
          ? { interviewer: receipt.interviewerUrl }
          : {}),
      });
    } catch (reason) {
      setPublishError(
        reason instanceof Error
          ? reason.message
          : "Canonical sharing is unavailable.",
      );
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="designer-shell">
      <header className="designer-header">
        <Link className="wordmark" to="/" aria-label="SystemForge home">
          <BrandIcon />
          <strong>SystemForge</strong>
        </Link>
        <div className="designer-header__title">
          <span>
            {mode === "interview" ? "Interview studio" : "Challenge studio"}
          </span>
          <strong>{scenario.title}</strong>
        </div>
        <div className="designer-header__actions">
          {validationMessage ? (
            <span className="designer-validation" role="status">
              Contract blocked · {validationMessage}
            </span>
          ) : null}
          <button
            className="button button--primary"
            type="button"
            onClick={openLab}
            disabled={!validation.success}
          >
            <span className="designer-cta-full">Compile and open lab</span>
            <span className="designer-cta-compact">Open Lab</span>
            <ArrowRight size={16} />
          </button>
        </div>
      </header>

      <main className="designer-workspace">
        <aside className="designer-rail">
          <Link to="/">
            <ArrowLeft size={15} /> Exit studio
          </Link>
          <span className="panel-index">MISSION CONTRACT</span>
          <h1>
            {mode === "interview"
              ? "Control what the candidate knows."
              : "Author the problem, not the answer."}
          </h1>
          <p>
            Every field changes the simulation contract. Nothing here selects a
            predetermined winning architecture.
          </p>
          <nav aria-label="Scenario contract sections">
            <a href="#brief">
              <span>01</span> Brief
            </a>
            {mode === "interview" ? (
              <a href="#facilitation">
                <span>02</span> Facilitation
              </a>
            ) : null}
            <a href="#demand">
              <span>{mode === "interview" ? "03" : "02"}</span> Demand
            </a>
            <a href="#requests">
              <span>{mode === "interview" ? "04" : "03"}</span> Request mix
            </a>
            <a href="#regions">
              <span>{mode === "interview" ? "05" : "04"}</span> Regions
            </a>
            <a href="#invariants">
              <span>{mode === "interview" ? "06" : "05"}</span> Invariants
            </a>
            <a href="#failures">
              <span>{mode === "interview" ? "07" : "06"}</span> Failures
            </a>
            <a href="#objectives">
              <span>{mode === "interview" ? "08" : "07"}</span> Objectives
            </a>
            <a href="#share">
              <span>{mode === "interview" ? "09" : "08"}</span> Handoff
            </a>
          </nav>
          <div className="contract-status">
            <span
              className={
                Math.abs(regionalShare - 1) < 0.001 ? "valid" : "invalid"
              }
            >
              {Math.abs(regionalShare - 1) < 0.001 ? (
                <Check size={14} />
              ) : (
                <Warning size={14} />
              )}
              Region split {formatShare(regionalShare)}
            </span>
            <span
              className={
                Math.abs(requestShare - 1) < 0.001 ? "valid" : "invalid"
              }
            >
              {Math.abs(requestShare - 1) < 0.001 ? (
                <Check size={14} />
              ) : (
                <Warning size={14} />
              )}
              Request mix {formatShare(requestShare)}
            </span>
            <span className="valid">
              <Check size={14} /> {scenario.incidents.length} incidents armed
            </span>
          </div>
        </aside>

        <form
          className="contract-editor"
          onSubmit={(event) => event.preventDefault()}
        >
          <section
            className="contract-section contract-section--brief"
            id="brief"
            data-collapsed={collapsedSections.has("brief")}
          >
            <header>
              <span className="section-number">01</span>
              <div>
                <small>CONTEXT ENVELOPE</small>
                <h2>Mission brief</h2>
              </div>
              <p>Visible framing shared with every participant.</p>
              {sectionCollapse("brief")}
            </header>
            <div className="contract-fields contract-fields--brief">
              <label>
                Mission title
                <input
                  value={scenario.title}
                  maxLength={120}
                  onChange={(event) =>
                    setDraft({ ...scenario, title: event.target.value })
                  }
                />
              </label>
              <label>
                Scenario seed
                <input
                  type="number"
                  min="0"
                  value={scenario.seed}
                  onChange={(event) =>
                    setDraft({ ...scenario, seed: Number(event.target.value) })
                  }
                />
              </label>
              <label className="field-span">
                Operational summary
                <textarea
                  value={scenario.summary}
                  maxLength={600}
                  rows={4}
                  onChange={(event) =>
                    setDraft({ ...scenario, summary: event.target.value })
                  }
                />
              </label>
              {scenario.interview ? (
                <label className="field-span">
                  Candidate brief
                  <textarea
                    value={scenario.interview.candidateBrief}
                    rows={5}
                    onChange={(event) =>
                      setDraft({
                        ...scenario,
                        interview: {
                          ...scenario.interview!,
                          candidateBrief: event.target.value,
                        },
                      })
                    }
                  />
                </label>
              ) : null}
            </div>
          </section>

          {scenario.interview ? (
            <section
              className="contract-section contract-section--private"
              id="facilitation"
              data-collapsed={collapsedSections.has("facilitation")}
            >
              <header>
                <span className="section-number">02</span>
                <div>
                  <small>PRIVATE CHANNEL</small>
                  <h2>Facilitation controls</h2>
                </div>
                <p>Never included in the candidate payload.</p>
                {sectionCollapse("facilitation")}
              </header>
              <div className="private-notice">
                <EyeSlash size={16} /> Interviewer-only contract
              </div>
              <div className="contract-fields">
                <label className="field-span">
                  Evaluation brief
                  <textarea
                    value={scenario.interview.interviewerBrief}
                    rows={5}
                    onChange={(event) =>
                      setDraft({
                        ...scenario,
                        interview: {
                          ...scenario.interview!,
                          interviewerBrief: event.target.value,
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Timebox (minutes)
                  <input
                    type="number"
                    min="5"
                    max="240"
                    value={scenario.interview.timeboxMinutes}
                    onChange={(event) =>
                      setDraft({
                        ...scenario,
                        interview: {
                          ...scenario.interview!,
                          timeboxMinutes: Number(event.target.value),
                        },
                      })
                    }
                  />
                </label>
                <label>
                  Reveal policy
                  <select
                    value={scenario.interview.revealPolicy}
                    onChange={(event) =>
                      setDraft({
                        ...scenario,
                        interview: {
                          ...scenario.interview!,
                          revealPolicy: event.target.value as NonNullable<
                            Scenario["interview"]
                          >["revealPolicy"],
                        },
                      })
                    }
                  >
                    <option value="interviewer-controlled">
                      Interviewer controlled
                    </option>
                    <option value="after-run">After first run</option>
                    <option value="never">Never reveal</option>
                  </select>
                  <small>
                    Reveal state is synchronized for canonical interview links.
                    Browser-local links always keep the private rubric out of
                    the candidate payload.
                  </small>
                </label>
                <label className="switch-field field-span">
                  <input
                    type="checkbox"
                    checked={scenario.interview.allowCandidateRequirements}
                    onChange={(event) =>
                      setDraft({
                        ...scenario,
                        interview: {
                          ...scenario.interview!,
                          allowCandidateRequirements: event.target.checked,
                        },
                      })
                    }
                  />
                  <span>
                    <strong>Candidate-derived requirements</strong>
                    <small>
                      Allow the candidate to record constraints they discover.
                    </small>
                  </span>
                </label>
              </div>
            </section>
          ) : null}

          <section
            className="contract-section"
            id="demand"
            data-collapsed={collapsedSections.has("demand")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "03" : "02"}
              </span>
              <div>
                <small>TRAFFIC GENERATOR</small>
                <h2>Demand envelope</h2>
              </div>
              <p>
                Arrival shape, concurrency, client patience, and retry pressure.
              </p>
              {sectionCollapse("demand")}
            </header>
            <div className="metric-field-grid">
              <label>
                Base RPS
                <input
                  type="number"
                  min="1"
                  value={scenario.workload.baseRps}
                  onChange={(event) =>
                    updateWorkload({ baseRps: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Peak RPS
                <input
                  type="number"
                  min="1"
                  value={scenario.workload.peakRps}
                  onChange={(event) =>
                    updateWorkload({ peakRps: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Concurrent users
                <input
                  type="number"
                  min="1"
                  value={scenario.workload.concurrentUsers ?? 1}
                  onChange={(event) =>
                    updateWorkload({
                      concurrentUsers: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Duration (seconds)
                <input
                  type="number"
                  min="15"
                  value={scenario.workload.durationSeconds}
                  onChange={(event) =>
                    updateWorkload({
                      durationSeconds: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Arrival pattern
                <select
                  value={scenario.workload.arrivalPattern ?? "steady"}
                  onChange={(event) =>
                    updateWorkload({
                      arrivalPattern: event.target
                        .value as Scenario["workload"]["arrivalPattern"],
                    })
                  }
                >
                  <option value="steady">Steady</option>
                  <option value="poisson">Poisson</option>
                  <option value="bursty">Bursty</option>
                </select>
              </label>
              <label>
                Read ratio
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.01"
                  value={scenario.workload.readRatio}
                  onChange={(event) =>
                    updateWorkload({ readRatio: Number(event.target.value) })
                  }
                />
              </label>
              <label>
                Client timeout (ms)
                <input
                  type="number"
                  min="50"
                  value={scenario.workload.clientTimeoutMs ?? 800}
                  onChange={(event) =>
                    updateWorkload({
                      clientTimeoutMs: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Maximum retries
                <input
                  type="number"
                  min="0"
                  max="12"
                  value={scenario.workload.retryPolicy?.maxRetries ?? 0}
                  onChange={(event) =>
                    updateWorkload({
                      retryPolicy: {
                        maxRetries: Number(event.target.value),
                        backoffBaseMs:
                          scenario.workload.retryPolicy?.backoffBaseMs ?? 100,
                        jitter: scenario.workload.retryPolicy?.jitter ?? true,
                        retryOnTimeout:
                          scenario.workload.retryPolicy?.retryOnTimeout ?? true,
                      },
                    })
                  }
                />
              </label>
              <label>
                Backoff base (ms)
                <input
                  type="number"
                  min="0"
                  value={scenario.workload.retryPolicy?.backoffBaseMs ?? 0}
                  onChange={(event) =>
                    updateWorkload({
                      retryPolicy: {
                        maxRetries:
                          scenario.workload.retryPolicy?.maxRetries ?? 0,
                        backoffBaseMs: Number(event.target.value),
                        jitter: scenario.workload.retryPolicy?.jitter ?? true,
                        retryOnTimeout:
                          scenario.workload.retryPolicy?.retryOnTimeout ?? true,
                      },
                    })
                  }
                />
              </label>
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={scenario.workload.retryPolicy?.jitter ?? false}
                  onChange={(event) =>
                    updateWorkload({
                      retryPolicy: {
                        maxRetries:
                          scenario.workload.retryPolicy?.maxRetries ?? 0,
                        backoffBaseMs:
                          scenario.workload.retryPolicy?.backoffBaseMs ?? 0,
                        jitter: event.target.checked,
                        retryOnTimeout:
                          scenario.workload.retryPolicy?.retryOnTimeout ?? true,
                      },
                    })
                  }
                />
                <span>
                  <strong>Retry jitter</strong>
                  <small>Desynchronise retry waves</small>
                </span>
              </label>
              <label className="switch-field">
                <input
                  aria-label="Retry on client timeout"
                  type="checkbox"
                  checked={
                    scenario.workload.retryPolicy?.retryOnTimeout ?? true
                  }
                  onChange={(event) =>
                    updateWorkload({
                      retryPolicy: {
                        maxRetries:
                          scenario.workload.retryPolicy?.maxRetries ?? 0,
                        backoffBaseMs:
                          scenario.workload.retryPolicy?.backoffBaseMs ?? 0,
                        jitter: scenario.workload.retryPolicy?.jitter ?? true,
                        retryOnTimeout: event.target.checked,
                      },
                    })
                  }
                />
                <span>
                  <strong>Retry on client timeout</strong>
                  <small>Trade recovery attempts for retry amplification</small>
                </span>
              </label>
            </div>
          </section>

          <section
            className="contract-section"
            id="requests"
            data-collapsed={collapsedSections.has("requests")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "04" : "03"}
              </span>
              <div>
                <small>WORKLOAD COMPOSITION</small>
                <h2>Request mix</h2>
              </div>
              <button
                type="button"
                disabled={(scenario.workload.requestMix?.length ?? 0) >= 40}
                onClick={() =>
                  updateWorkload({
                    requestMix: [
                      ...(scenario.workload.requestMix ?? []),
                      requestTemplate(
                        scenario.workload.requestMix?.length ?? 0,
                      ),
                    ],
                  })
                }
              >
                <Plus size={14} /> Add class
              </button>
              {sectionCollapse("requests")}
            </header>
            <div className="table-editor request-table">
              <div className="table-editor__head">
                <span>Request class</span>
                <span>Share</span>
                <span>Reads</span>
                <span>Payload KB</span>
                <span>CPU ms</span>
                <span>DB queries</span>
                <span>Semantics</span>
                <span />
              </div>
              {(scenario.workload.requestMix ?? []).map((request, index) => (
                <div
                  className="table-editor__row"
                  key={`${request.name}-${index}`}
                >
                  <input
                    aria-label="Request class name"
                    value={request.name}
                    onChange={(event) =>
                      updateRequest(index, { name: event.target.value })
                    }
                  />
                  <input
                    aria-label="Traffic share"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={request.share}
                    onChange={(event) =>
                      updateRequest(index, {
                        share: Number(event.target.value),
                      })
                    }
                  />
                  <input
                    aria-label="Read ratio"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={request.readRatio}
                    onChange={(event) =>
                      updateRequest(index, {
                        readRatio: Number(event.target.value),
                      })
                    }
                  />
                  <input
                    aria-label="Payload kilobytes"
                    type="number"
                    min="0"
                    value={request.payloadKb}
                    onChange={(event) =>
                      updateRequest(index, {
                        payloadKb: Number(event.target.value),
                      })
                    }
                  />
                  <input
                    aria-label="Compute milliseconds"
                    type="number"
                    min="0"
                    value={request.computeMs}
                    onChange={(event) =>
                      updateRequest(index, {
                        computeMs: Number(event.target.value),
                      })
                    }
                  />
                  <input
                    aria-label="Database queries"
                    type="number"
                    min="0"
                    value={request.databaseQueries}
                    onChange={(event) =>
                      updateRequest(index, {
                        databaseQueries: Number(event.target.value),
                      })
                    }
                  />
                  <div className="inline-toggles">
                    <label>
                      <input
                        type="checkbox"
                        checked={request.cacheable}
                        onChange={(event) =>
                          updateRequest(index, {
                            cacheable: event.target.checked,
                          })
                        }
                      />{" "}
                      cacheable
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={request.critical}
                        onChange={(event) =>
                          updateRequest(index, {
                            critical: event.target.checked,
                          })
                        }
                      />{" "}
                      critical
                    </label>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${request.name}`}
                    onClick={() =>
                      updateWorkload({
                        requestMix: (scenario.workload.requestMix ?? []).filter(
                          (_, currentIndex) => currentIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section
            className="contract-section"
            id="regions"
            data-collapsed={collapsedSections.has("regions")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "05" : "04"}
              </span>
              <div>
                <small>GEOGRAPHIC PRESSURE</small>
                <h2>Regions and latency</h2>
              </div>
              <button
                type="button"
                disabled={scenario.workload.regions.length >= 12}
                onClick={() =>
                  updateWorkload({
                    regions: [
                      ...scenario.workload.regions,
                      { name: "New region", trafficShare: 0, roundTripMs: 80 },
                    ],
                  })
                }
              >
                <Plus size={14} /> Add region
              </button>
              {sectionCollapse("regions")}
            </header>
            <div className="table-editor region-table">
              <div className="table-editor__head">
                <span>Region</span>
                <span>Traffic share</span>
                <span>Round trip</span>
                <span />
              </div>
              {scenario.workload.regions.map((region, index) => (
                <div
                  className="table-editor__row"
                  key={`${region.name}-${index}`}
                >
                  <input
                    aria-label="Region name"
                    value={region.name}
                    onChange={(event) =>
                      updateRegion(index, { name: event.target.value })
                    }
                  />
                  <input
                    aria-label="Regional traffic share"
                    type="number"
                    min="0"
                    max="1"
                    step="0.01"
                    value={region.trafficShare}
                    onChange={(event) =>
                      updateRegion(index, {
                        trafficShare: Number(event.target.value),
                      })
                    }
                  />
                  <div className="unit-field">
                    <input
                      aria-label="Round-trip latency"
                      type="number"
                      min="0"
                      value={region.roundTripMs}
                      onChange={(event) =>
                        updateRegion(index, {
                          roundTripMs: Number(event.target.value),
                        })
                      }
                    />
                    <span>ms</span>
                  </div>
                  <button
                    type="button"
                    aria-label={`Remove ${region.name}`}
                    disabled={scenario.workload.regions.length === 1}
                    onClick={() =>
                      updateWorkload({
                        regions: scenario.workload.regions.filter(
                          (_, currentIndex) => currentIndex !== index,
                        ),
                      })
                    }
                  >
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section
            className="contract-section"
            id="invariants"
            data-collapsed={collapsedSections.has("invariants")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "06" : "05"}
              </span>
              <div>
                <small>DOMAIN SEMANTICS</small>
                <h2>Non-negotiable invariants</h2>
              </div>
              <p>
                Business meaning the architecture must preserve under failure.
              </p>
              {sectionCollapse("invariants")}
            </header>
            <div className="invariant-grid">
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={
                    scenario.domain?.acknowledgedWritesMustSurvive ?? false
                  }
                  onChange={(event) =>
                    updateDomain({
                      acknowledgedWritesMustSurvive: event.target.checked,
                    })
                  }
                />
                <span>
                  <strong>Acknowledged writes survive</strong>
                  <small>
                    No successful response may precede durable storage.
                  </small>
                </span>
              </label>
              <label className="switch-field">
                <input
                  type="checkbox"
                  checked={scenario.domain?.preventOversell ?? false}
                  onChange={(event) =>
                    updateDomain({ preventOversell: event.target.checked })
                  }
                />
                <span>
                  <strong>Prevent oversell</strong>
                  <small>
                    Inventory cannot be sold twice during partitions.
                  </small>
                </span>
              </label>
              <label>
                PII residency boundary
                <input
                  value={scenario.domain?.piiRegion ?? ""}
                  placeholder="EU"
                  onChange={(event) =>
                    updateDomain({ piiRegion: event.target.value || undefined })
                  }
                />
              </label>
              <label>
                Stale read tolerance (seconds)
                <input
                  type="number"
                  min="0"
                  value={scenario.domain?.staleReadToleranceSeconds ?? 0}
                  onChange={(event) =>
                    updateDomain({
                      staleReadToleranceSeconds: Number(event.target.value),
                    })
                  }
                />
              </label>
              <label>
                Maximum recovery time (seconds)
                <input
                  type="number"
                  min="0"
                  value={scenario.domain?.maximumRecoverySeconds ?? 0}
                  onChange={(event) =>
                    updateDomain({
                      maximumRecoverySeconds: Number(event.target.value),
                    })
                  }
                />
              </label>
            </div>
          </section>

          <section
            className="contract-section"
            id="failures"
            data-collapsed={collapsedSections.has("failures")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "07" : "06"}
              </span>
              <div>
                <small>INCIDENT SCHEDULE</small>
                <h2>Failure injection</h2>
              </div>
              <button
                type="button"
                disabled={scenario.incidents.length >= 40}
                onClick={() =>
                  setDraft({
                    ...scenario,
                    incidents: [
                      ...scenario.incidents,
                      incidentTemplate(scenario.incidents.length),
                    ],
                  })
                }
              >
                <Plus size={14} /> Arm incident
              </button>
              {sectionCollapse("failures")}
            </header>
            <div className="incident-stack">
              {scenario.incidents.map((incident, index) => (
                <div className="incident-row" key={incident.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <label>
                    Failure
                    <select
                      value={incident.kind}
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          kind: event.target.value as Incident["kind"],
                        })
                      }
                    >
                      {INCIDENT_KINDS.map((kind) => (
                        <option value={kind} key={kind}>
                          {titleCase(kind)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    At second
                    <input
                      type="number"
                      min="0"
                      max={scenario.workload.durationSeconds}
                      value={incident.atSecond}
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          atSecond: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Magnitude
                    <input
                      type="number"
                      min="0.01"
                      step="0.1"
                      value={incident.magnitude}
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          magnitude: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label>
                    Duration
                    <input
                      type="number"
                      min="1"
                      value={incident.durationSeconds ?? 1}
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          durationSeconds: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="incident-label">
                    Operational label
                    <input
                      value={incident.label}
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          label: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Target node ID
                    <input
                      value={incident.targetId ?? ""}
                      placeholder="db"
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          targetId: event.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <label>
                    Region
                    <input
                      value={incident.region ?? ""}
                      placeholder="EU"
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          region: event.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <label>
                    Zone
                    <input
                      value={incident.zone ?? ""}
                      placeholder="eu-1a"
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          zone: event.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <label>
                    Failure domain
                    <input
                      value={incident.failureDomain ?? ""}
                      placeholder="payments-cell-a"
                      onChange={(event) =>
                        updateIncident(incident.id, {
                          failureDomain: event.target.value || undefined,
                        })
                      }
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Remove ${incident.label}`}
                    onClick={() =>
                      setDraft({
                        ...scenario,
                        incidents: scenario.incidents.filter(
                          (current) => current.id !== incident.id,
                        ),
                      })
                    }
                  >
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section
            className="contract-section"
            id="objectives"
            data-collapsed={collapsedSections.has("objectives")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "08" : "07"}
              </span>
              <div>
                <small>SUCCESS ENVELOPE</small>
                <h2>Objectives and trade-offs</h2>
              </div>
              <p>
                {mode === "interview"
                  ? "Author the visible brief and private rubric here. Candidates record derived constraints in the lab."
                  : "Define the measurable outcomes used to evaluate each run."}
              </p>
              <button
                type="button"
                disabled={scenario.requirements.length >= 40}
                onClick={() =>
                  setDraft({
                    ...scenario,
                    requirements: [
                      ...scenario.requirements,
                      requirementTemplate(scenario.requirements.length, mode),
                    ],
                  })
                }
              >
                <Plus size={14} /> Add objective
              </button>
              {sectionCollapse("objectives")}
            </header>
            <div className="requirement-stack">
              {scenario.requirements.map((requirement, index) => (
                <div className="requirement-row" key={requirement.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <input
                    aria-label="Requirement label"
                    value={requirement.label}
                    onChange={(event) =>
                      updateRequirement(requirement.id, {
                        label: event.target.value,
                      })
                    }
                  />
                  <select
                    aria-label="Metric"
                    value={requirement.metric}
                    onChange={(event) =>
                      updateRequirement(requirement.id, {
                        metric: event.target.value as Requirement["metric"],
                      })
                    }
                  >
                    {METRIC_NAMES.map((metric) => (
                      <option value={metric} key={metric}>
                        {titleCase(metric)}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Operator"
                    value={requirement.operator}
                    onChange={(event) =>
                      updateRequirement(requirement.id, {
                        operator: event.target.value as Requirement["operator"],
                      })
                    }
                  >
                    <option value="lte">at most</option>
                    <option value="gte">at least</option>
                    <option value="eq">exactly</option>
                  </select>
                  <input
                    aria-label="Target"
                    type="number"
                    value={requirement.target}
                    onChange={(event) =>
                      updateRequirement(requirement.id, {
                        target: Number(event.target.value),
                      })
                    }
                  />
                  <input
                    aria-label="Unit"
                    value={requirement.unit}
                    onChange={(event) =>
                      updateRequirement(requirement.id, {
                        unit: event.target.value,
                      })
                    }
                  />
                  {mode === "interview" ? (
                    <select
                      aria-label="Visibility"
                      value={requirement.visibility}
                      onChange={(event) =>
                        updateRequirement(requirement.id, {
                          visibility: event.target
                            .value as Requirement["visibility"],
                        })
                      }
                    >
                      <option value="hidden">Interviewer only</option>
                      <option value="public">Visible</option>
                    </select>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Remove ${requirement.label}`}
                    onClick={() =>
                      setDraft({
                        ...scenario,
                        requirements: scenario.requirements.filter(
                          (current) => current.id !== requirement.id,
                        ),
                      })
                    }
                  >
                    <Trash size={14} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          <section
            className="contract-section contract-section--handoff"
            id="share"
            data-collapsed={collapsedSections.has("share")}
          >
            <header>
              <span className="section-number">
                {mode === "interview" ? "09" : "08"}
              </span>
              <div>
                <small>MISSION HANDOFF</small>
                <h2>Launch and share</h2>
              </div>
              <ShieldCheck size={22} />
              {sectionCollapse("share")}
            </header>
            <div className="handoff-grid">
              <div className="handoff-local">
                <strong>Browser-local links</strong>
                <p>
                  No backend or account required. Interviewer links contain the
                  private rubric; candidate links contain only the safe
                  challenge contract.
                </p>
                {links ? (
                  <>
                    <CopyField
                      label="Interviewer link"
                      value={links.interviewer}
                      copied={copied === "interviewer"}
                      onCopy={() => void copy("interviewer", links.interviewer)}
                      disabled={!validation.success}
                    />
                    <CopyField
                      label="Candidate link"
                      value={links.candidate}
                      copied={copied === "candidate"}
                      onCopy={() => void copy("candidate", links.candidate)}
                      disabled={!validation.success}
                    />
                  </>
                ) : (
                  <CopyField
                    label="Challenge link"
                    value={customLink}
                    copied={copied === "challenge"}
                    onCopy={() => void copy("challenge", customLink)}
                    disabled={!validation.success}
                  />
                )}
              </div>
              <div className="handoff-canonical">
                <strong>Canonical short link</strong>
                <p>
                  Requires the private service, which remains closed until
                  production release is explicitly approved.
                </p>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={publishing || !validation.success}
                  onClick={() => void publish()}
                >
                  <CloudArrowUp size={16} />
                  {publishing ? "Publishing…" : "Request canonical link"}
                </button>
                {publishError ? (
                  <p className="form-error">
                    {publishError} The local links remain available.
                  </p>
                ) : null}
                {canonicalLinks ? (
                  <div className="canonical-links">
                    <CopyField
                      label={
                        mode === "interview"
                          ? "Candidate canonical link"
                          : "Canonical challenge link"
                      }
                      value={canonicalLinks.participant}
                      copied={copied === "canonical-participant"}
                      onCopy={() =>
                        void copy(
                          "canonical-participant",
                          canonicalLinks.participant,
                        )
                      }
                    />
                    {canonicalLinks.interviewer ? (
                      <CopyField
                        label="Interviewer canonical link"
                        value={canonicalLinks.interviewer}
                        copied={copied === "canonical-interviewer"}
                        onCopy={() =>
                          void copy(
                            "canonical-interviewer",
                            canonicalLinks.interviewer!,
                          )
                        }
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
            <button
              className="compile-action"
              type="button"
              onClick={openLab}
              disabled={!validation.success}
            >
              <span>Compile mission contract</span>
              <strong>Open architecture workspace</strong>
              <ArrowRight size={20} />
            </button>
          </section>
        </form>
        <aside
          className="designer-summary"
          aria-label="Live mission contract summary"
        >
          <header>
            <span className="panel-index">LIVE CONTRACT</span>
            <strong>
              {completedSections}/{sectionStates.length} sections ready
            </strong>
            <div
              className="designer-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={sectionStates.length}
              aria-valuenow={completedSections}
              aria-label="Scenario contract completion"
            >
              <i
                style={{
                  width: `${(completedSections / sectionStates.length) * 100}%`,
                }}
              />
            </div>
          </header>
          <ol>
            {sectionStates.map((section, index) => (
              <li
                className={section.complete ? "complete" : "pending"}
                key={section.id}
              >
                <a
                  href={`#${section.id}`}
                  onClick={() => {
                    if (collapsedSections.has(section.id))
                      toggleSection(section.id);
                  }}
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <strong>{section.label}</strong>
                  {section.complete ? (
                    <Check size={14} />
                  ) : (
                    <Warning size={14} />
                  )}
                </a>
              </li>
            ))}
          </ol>
          <section className="designer-summary__metrics">
            <span>Current envelope</span>
            <dl>
              <div>
                <dt>Peak</dt>
                <dd>{scenario.workload.peakRps.toLocaleString("en-US")} RPS</dd>
              </div>
              <div>
                <dt>Regions</dt>
                <dd>{scenario.workload.regions.length}</dd>
              </div>
              <div>
                <dt>Incidents</dt>
                <dd>{scenario.incidents.length}</dd>
              </div>
              <div>
                <dt>Objectives</dt>
                <dd>{scenario.requirements.length}</dd>
              </div>
            </dl>
          </section>
          {nextIncomplete ? (
            <a
              className="designer-summary__next"
              href={`#${nextIncomplete.id}`}
              onClick={() => {
                if (collapsedSections.has(nextIncomplete.id))
                  toggleSection(nextIncomplete.id);
              }}
            >
              Continue with <strong>{nextIncomplete.label}</strong>{" "}
              <ArrowRight size={14} />
            </a>
          ) : (
            <button
              className="designer-summary__next"
              type="button"
              disabled={!validation.success}
              onClick={openLab}
            >
              Contract ready <strong>Open the Lab</strong>{" "}
              <ArrowRight size={14} />
            </button>
          )}
          <footer>
            <ShieldCheck size={15} />
            <span>
              {mode === "interview"
                ? "Private rubric remains outside candidate payloads."
                : "Draft remains in this browser until you request a canonical link."}
            </span>
          </footer>
        </aside>
      </main>
    </div>
  );
}

interface CopyFieldProps {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
  disabled?: boolean;
}

function CopyField({
  label,
  value,
  copied,
  onCopy,
  disabled = false,
}: CopyFieldProps) {
  return (
    <label className="copy-field-label">
      {label}
      <span className="copy-field">
        <input readOnly value={value} disabled={disabled} />
        <button type="button" onClick={onCopy} disabled={disabled}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </label>
  );
}
