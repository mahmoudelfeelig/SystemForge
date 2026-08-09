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
  incidentUsesMagnitude,
  MAX_GENERATED_INCIDENTS,
  MAX_STOCHASTIC_INCIDENT_RULES,
  METRIC_NAMES,
  scenarioSchema,
  STOCHASTIC_INCIDENT_TRIGGER_METRICS,
  type Incident,
  type Requirement,
  type Scenario,
} from "@systemforge/contracts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { BrandIcon } from "../components/BrandIcon";
import { ScenarioAiAssistant } from "../components/AiAssistantPanels";
import { shareScenario } from "../lib/api";
import {
  encodeLocalShare,
  interviewShareLinks,
  LocalShareTooLargeError,
  scenarioForLocalShare,
} from "../lib/share";
import { useLabStore } from "../store/useLabStore";

interface ScenarioDesignerPageProps {
  mode: "custom" | "interview";
}

type RequestProfile = NonNullable<Scenario["workload"]["requestMix"]>[number];
type RegionProfile = Scenario["workload"]["regions"][number];
type StochasticIncidentModel = NonNullable<Scenario["stochasticIncidents"]>;
type StochasticIncidentRule = StochasticIncidentModel["rules"][number];
type StochasticTriggerMetric = NonNullable<
  StochasticIncidentRule["trigger"]
>["metric"];
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

const stochasticIncidentRuleTemplate = (
  index: number,
): StochasticIncidentRule => ({
  id: `seeded-rule-${Date.now()}-${index}`,
  enabled: true,
  kind: "node-failure",
  label: "Seeded node failure",
  hazardRatePerSecond: 0.01,
  cooldownSeconds: 30,
  maxOccurrences: 2,
  magnitude: 1,
  durationSeconds: 10,
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
        : "Untitled system scenario",
    summary:
      mode === "interview"
        ? "Assess how the candidate handles durability, consistency, regional data, recovery, and overload."
        : "Describe the workload, failure schedule, and checks for this scenario.",
    mode,
    requirements:
      mode === "interview"
        ? [requirementTemplate(0, mode)]
        : structuredClone(DEFAULT_SCENARIO.requirements),
    interview:
      mode === "interview"
        ? {
            candidateBrief:
              "Design the backend for a global ordering service. Ask clarifying questions before choosing an architecture.",
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
  const publishSequence = useRef(0);
  const [collapsedSections, setCollapsedSections] = useState<
    Set<DesignerSectionId>
  >(
    new Set([
      "facilitation",
      "demand",
      "requests",
      "regions",
      "invariants",
      "failures",
      "objectives",
      "share",
    ]),
  );
  useEffect(() => {
    publishSequence.current += 1;
    setCanonicalLinks(null);
    setPublishing(false);
  }, [scenario]);
  const validation = useMemo(
    () => scenarioSchema.safeParse(scenario),
    [scenario],
  );
  const validationMessage = validation.success
    ? null
    : `${validation.error.issues[0]?.path.join(".") || "scenario"}: ${validation.error.issues[0]?.message ?? "The scenario is invalid."}`;

  const localShare = useMemo(() => {
    try {
      return {
        links:
          mode === "interview"
            ? interviewShareLinks(scenario, DEFAULT_ARCHITECTURE)
            : null,
        customLink:
          mode === "custom"
            ? `${window.location.origin}/lab#share=${encodeLocalShare({ scenario: scenarioForLocalShare(scenario, "participant"), architecture: DEFAULT_ARCHITECTURE, role: "participant" })}`
            : null,
        error: null,
      };
    } catch (error) {
      return {
        links: null,
        customLink: null,
        error:
          error instanceof LocalShareTooLargeError
            ? "This draft is too large for a safe browser-local URL. Create a server-backed short link instead."
            : "SystemForge could not prepare the local share links.",
      };
    }
  }, [mode, scenario]);
  const localLinks = localShare.links;
  const customLink = localShare.customLink;
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
        label: "Workload",
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
        label: "Incidents",
        complete:
          scenario.incidents.length > 0 ||
          Boolean(
            scenario.stochasticIncidents?.enabled &&
            scenario.stochasticIncidents.rules.some((rule) => rule.enabled),
          ),
      },
      {
        id: "objectives" as const,
        label: "Objectives",
        complete: scenario.requirements.length > 0,
      },
      {
        id: "share" as const,
        label: "Share",
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
      if (!current.has(id))
        return new Set(sectionStates.map((section) => section.id));
      return new Set(
        sectionStates
          .map((section) => section.id)
          .filter((sectionId) => sectionId !== id),
      );
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
  const updateStochasticModel = (patch: Partial<StochasticIncidentModel>) =>
    setDraft((current) => ({
      ...current,
      stochasticIncidents: {
        enabled: current.stochasticIncidents?.enabled ?? false,
        maxGeneratedIncidents:
          current.stochasticIncidents?.maxGeneratedIncidents ?? 8,
        rules: current.stochasticIncidents?.rules ?? [],
        ...patch,
      },
    }));
  const updateStochasticRule = (
    id: string,
    patch: Partial<StochasticIncidentRule>,
  ) =>
    updateStochasticModel({
      rules: (scenario.stochasticIncidents?.rules ?? []).map((rule) =>
        rule.id === id ? { ...rule, ...patch } : rule,
      ),
    });
  const updateStochasticRuleScope = (
    id: string,
    patch: Partial<NonNullable<StochasticIncidentRule["scope"]>>,
  ) => {
    const currentRule = scenario.stochasticIncidents?.rules.find(
      (rule) => rule.id === id,
    );
    updateStochasticRule(id, {
      scope: {
        correlated: currentRule?.scope?.correlated ?? false,
        ...currentRule?.scope,
        ...patch,
      },
    });
  };
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
  const publish = async () => {
    if (!validation.success) {
      setPublishError(validationMessage);
      return;
    }
    const requestSequence = ++publishSequence.current;
    setPublishing(true);
    setPublishError(null);
    try {
      const receipt = await shareScenario(
        validation.data,
        DEFAULT_ARCHITECTURE,
      );
      if (requestSequence !== publishSequence.current) return;
      setCanonicalLinks({
        participant: receipt.candidateUrl ?? receipt.url,
        ...(receipt.interviewerUrl
          ? { interviewer: receipt.interviewerUrl }
          : {}),
      });
    } catch (reason) {
      if (requestSequence !== publishSequence.current) return;
      setPublishError(
        reason instanceof Error
          ? reason.message
          : "The online service could not create this short link.",
      );
    } finally {
      if (requestSequence === publishSequence.current) setPublishing(false);
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
            {mode === "interview" ? "Interview setup" : "Scenario editor"}
          </span>
          <strong>{scenario.title}</strong>
        </div>
        <div className="designer-header__actions">
          {validationMessage ? (
            <span className="designer-validation" role="status">
              Fix this field before opening the Lab: {validationMessage}
            </span>
          ) : null}
          <button
            className="button button--primary"
            type="button"
            onClick={openLab}
            disabled={!validation.success}
          >
            <span className="designer-cta-full">Open in Lab</span>
            <span className="designer-cta-compact">Open Lab</span>
            <ArrowRight size={16} />
          </button>
        </div>
      </header>

      <main className="designer-workspace">
        <aside className="designer-rail">
          <Link to="/">
            <ArrowLeft size={15} /> Exit editor
          </Link>
          <span className="panel-index">
            {mode === "interview" ? "INTERVIEW" : "SCENARIO"}
          </span>
          <h1>
            {mode === "interview" ? "Prepare the interview" : "Define the test"}
          </h1>
          <p>
            {mode === "interview"
              ? "Write the candidate brief, private rubric, and reveal rules."
              : "Set the workload, failure schedule, and pass criteria."}
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
              <span>{mode === "interview" ? "03" : "02"}</span> Workload
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
              <span>{mode === "interview" ? "07" : "06"}</span> Incidents
            </a>
            <a href="#objectives">
              <span>{mode === "interview" ? "08" : "07"}</span> Objectives
            </a>
            <a href="#share">
              <span>{mode === "interview" ? "09" : "08"}</span> Share
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
              <Check size={14} /> {scenario.incidents.length} scheduled,{" "}
              {scenario.stochasticIncidents?.rules.length ?? 0} seeded rules
            </span>
          </div>
        </aside>

        <form
          className="contract-editor"
          onSubmit={(event) => event.preventDefault()}
        >
          <ScenarioAiAssistant
            scenario={scenario}
            architecture={DEFAULT_ARCHITECTURE}
            mode={mode}
            onApplyScenario={setDraft}
            onApplyRequirements={(requirements) => {
              const incomingById = new Map(
                requirements.map((requirement) => [
                  requirement.id,
                  requirement,
                ]),
              );
              const merged = scenario.requirements.map(
                (requirement) =>
                  incomingById.get(requirement.id) ?? requirement,
              );
              for (const requirement of requirements)
                if (
                  !scenario.requirements.some(({ id }) => id === requirement.id)
                )
                  merged.push(requirement);
              if (merged.length > 40)
                return "Applying this proposal would exceed the 40-objective scenario limit. Remove an objective or discard the proposal.";
              const proposal = scenarioSchema.safeParse({
                ...scenario,
                requirements: merged,
              });
              if (!proposal.success)
                return `The combined objective set is invalid: ${proposal.error.issues[0]?.message ?? "review the proposal"}.`;
              setDraft(proposal.data);
              return null;
            }}
          />
          <section
            className="contract-section contract-section--brief"
            id="brief"
            data-collapsed={collapsedSections.has("brief")}
          >
            <header>
              <span className="section-number">01</span>
              <div>
                <small>SCENARIO</small>
                <h2>
                  {mode === "interview" ? "Candidate brief" : "Scenario brief"}
                </h2>
              </div>
              <p>
                {mode === "interview"
                  ? "Shared with every candidate link."
                  : "Name the scenario and describe the system under test."}
              </p>
              {sectionCollapse("brief")}
            </header>
            <div className="contract-fields contract-fields--brief">
              <label>
                Scenario title
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
                Scenario summary
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
                  <small>INTERVIEWER ONLY</small>
                  <h2>Private rubric</h2>
                </div>
                <p>Only interviewer links can access this.</p>
                {sectionCollapse("facilitation")}
              </header>
              <div className="private-notice">
                <EyeSlash size={16} /> Excluded from candidate links
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
                    <option value="after-run">After first server run</option>
                    <option value="never">Never reveal</option>
                  </select>
                  <small>
                    Server-backed interview links synchronize reveal state.
                    Local candidate links always exclude private criteria.
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
                    <strong>Candidate can record requirements</strong>
                    <small>Let candidates save constraints they uncover.</small>
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
                <small>WORKLOAD</small>
                <h2>Traffic profile</h2>
              </div>
              <p>Traffic, concurrency, timeouts, and retries.</p>
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
                <small>REGIONS</small>
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
                <h2>Correctness constraints</h2>
              </div>
              <p>Rules that must hold during failure.</p>
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
                <small>INCIDENTS</small>
                <h2>Incident schedule</h2>
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
                <Plus size={14} /> Add incident
              </button>
              {sectionCollapse("failures")}
            </header>
            <div className="seeded-incident-model">
              <div className="seeded-incident-toolbar">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    aria-label="Enable seeded incident model"
                    checked={scenario.stochasticIncidents?.enabled ?? false}
                    onChange={(event) =>
                      updateStochasticModel({ enabled: event.target.checked })
                    }
                  />
                  <span>
                    <strong>Enable seeded incident model</strong>
                    <small>Generate bounded incidents during a run.</small>
                  </span>
                </label>
                <label>
                  Maximum generated incidents
                  <input
                    type="number"
                    min="1"
                    max={MAX_GENERATED_INCIDENTS}
                    value={
                      scenario.stochasticIncidents?.maxGeneratedIncidents ?? 8
                    }
                    onChange={(event) =>
                      updateStochasticModel({
                        maxGeneratedIncidents: Number(event.target.value),
                      })
                    }
                  />
                </label>
                <button
                  type="button"
                  disabled={
                    (scenario.stochasticIncidents?.rules.length ?? 0) >=
                    MAX_STOCHASTIC_INCIDENT_RULES
                  }
                  onClick={() =>
                    updateStochasticModel({
                      enabled: scenario.stochasticIncidents?.enabled ?? true,
                      rules: [
                        ...(scenario.stochasticIncidents?.rules ?? []),
                        stochasticIncidentRuleTemplate(
                          scenario.stochasticIncidents?.rules.length ?? 0,
                        ),
                      ],
                    })
                  }
                >
                  <Plus size={14} /> Add seeded rule
                </button>
              </div>
              <p className="seeded-incident-copy">
                Generated from the scenario seed. Identical inputs replay the
                same incidents. These are test conditions, not measured failure
                rates.
              </p>
              <div className="seeded-rule-stack">
                {(scenario.stochasticIncidents?.rules ?? []).map(
                  (rule, index) => (
                    <fieldset className="seeded-rule" key={rule.id}>
                      <legend>
                        SEEDED RULE {String(index + 1).padStart(2, "0")}
                      </legend>
                      <label className="toggle-row seeded-rule__enabled">
                        <input
                          type="checkbox"
                          aria-label="Rule enabled"
                          checked={rule.enabled}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>Rule enabled</strong>
                          <small>
                            Disabled rules consume no incident draws.
                          </small>
                        </span>
                      </label>
                      <label>
                        Rule label
                        <input
                          value={rule.label}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              label: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Rule failure
                        <select
                          value={rule.kind}
                          onChange={(event) => {
                            const kind = event.target.value as Incident["kind"];
                            updateStochasticRule(rule.id, {
                              kind,
                              ...(incidentUsesMagnitude(kind)
                                ? {}
                                : { magnitude: 1 }),
                            });
                          }}
                        >
                          {INCIDENT_KINDS.map((kind) => (
                            <option value={kind} key={kind}>
                              {titleCase(kind)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Hazard per eligible second
                        <input
                          type="number"
                          min="0"
                          max="1"
                          step="0.001"
                          value={rule.hazardRatePerSecond}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              hazardRatePerSecond: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Cooldown seconds
                        <input
                          type="number"
                          min="0"
                          value={rule.cooldownSeconds}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              cooldownSeconds: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Maximum occurrences
                        <input
                          type="number"
                          min="1"
                          max="32"
                          value={rule.maxOccurrences}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              maxOccurrences: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Rule magnitude
                        <input
                          type="number"
                          min="0.01"
                          max={incidentUsesMagnitude(rule.kind) ? 100 : 1}
                          step="0.1"
                          value={rule.magnitude}
                          disabled={!incidentUsesMagnitude(rule.kind)}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              magnitude: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Rule duration seconds
                        <input
                          type="number"
                          min="1"
                          value={rule.durationSeconds}
                          onChange={(event) =>
                            updateStochasticRule(rule.id, {
                              durationSeconds: Number(event.target.value),
                            })
                          }
                        />
                      </label>
                      <label>
                        Scope target node ID
                        <input
                          value={rule.scope?.targetId ?? ""}
                          placeholder="db"
                          onChange={(event) =>
                            updateStochasticRuleScope(rule.id, {
                              targetId: event.target.value || undefined,
                              ...(event.target.value
                                ? { correlated: false }
                                : {}),
                            })
                          }
                        />
                      </label>
                      <label>
                        Scope region
                        <input
                          value={rule.scope?.region ?? ""}
                          placeholder="EU"
                          onChange={(event) =>
                            updateStochasticRuleScope(rule.id, {
                              region: event.target.value || undefined,
                            })
                          }
                        />
                      </label>
                      <label>
                        Scope zone
                        <input
                          value={rule.scope?.zone ?? ""}
                          placeholder="eu-1a"
                          onChange={(event) =>
                            updateStochasticRuleScope(rule.id, {
                              zone: event.target.value || undefined,
                            })
                          }
                        />
                      </label>
                      <label>
                        Scope failure domain
                        <input
                          value={rule.scope?.failureDomain ?? ""}
                          placeholder="cluster"
                          onChange={(event) =>
                            updateStochasticRuleScope(rule.id, {
                              failureDomain: event.target.value || undefined,
                            })
                          }
                        />
                      </label>
                      <label className="toggle-row seeded-rule__correlated">
                        <input
                          type="checkbox"
                          aria-label="Correlate matching scope"
                          checked={rule.scope?.correlated ?? false}
                          disabled={Boolean(rule.scope?.targetId)}
                          onChange={(event) =>
                            updateStochasticRuleScope(rule.id, {
                              correlated: event.target.checked,
                            })
                          }
                        />
                        <span>
                          <strong>Correlate matching scope</strong>
                          <small>
                            Affect every eligible node in the region or failure
                            domain.
                          </small>
                        </span>
                      </label>
                      <label>
                        State trigger metric
                        <select
                          value={rule.trigger?.metric ?? ""}
                          onChange={(event) => {
                            const metric = event.target.value;
                            updateStochasticRule(rule.id, {
                              trigger: metric
                                ? {
                                    metric: metric as StochasticTriggerMetric,
                                    operator: "gte",
                                    threshold: 0,
                                  }
                                : undefined,
                            });
                          }}
                        >
                          <option value="">No state trigger</option>
                          {STOCHASTIC_INCIDENT_TRIGGER_METRICS.map((metric) => (
                            <option value={metric} key={metric}>
                              {titleCase(metric)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        Trigger operator
                        <select
                          disabled={!rule.trigger}
                          value={rule.trigger?.operator ?? "gte"}
                          onChange={(event) =>
                            rule.trigger
                              ? updateStochasticRule(rule.id, {
                                  trigger: {
                                    ...rule.trigger,
                                    operator: event.target.value as
                                      "gte" | "lte",
                                  },
                                })
                              : undefined
                          }
                        >
                          <option value="gte">At or above</option>
                          <option value="lte">At or below</option>
                        </select>
                      </label>
                      <label>
                        Trigger threshold
                        <input
                          type="number"
                          min="0"
                          disabled={!rule.trigger}
                          value={rule.trigger?.threshold ?? 0}
                          onChange={(event) =>
                            rule.trigger
                              ? updateStochasticRule(rule.id, {
                                  trigger: {
                                    ...rule.trigger,
                                    threshold: Number(event.target.value),
                                  },
                                })
                              : undefined
                          }
                        />
                      </label>
                      <button
                        type="button"
                        aria-label={`Remove seeded rule ${rule.label}`}
                        onClick={() =>
                          updateStochasticModel({
                            rules:
                              scenario.stochasticIncidents?.rules.filter(
                                (current) => current.id !== rule.id,
                              ) ?? [],
                          })
                        }
                      >
                        <Trash size={14} /> Remove rule
                      </button>
                    </fieldset>
                  ),
                )}
              </div>
            </div>
            <div className="incident-stack">
              {scenario.incidents.map((incident, index) => (
                <div className="incident-row" key={incident.id}>
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <label>
                    Failure
                    <select
                      value={incident.kind}
                      onChange={(event) => {
                        const kind = event.target.value as Incident["kind"];
                        updateIncident(incident.id, {
                          kind,
                          ...(incidentUsesMagnitude(kind)
                            ? {}
                            : { magnitude: 1 }),
                        });
                      }}
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
                      min={incidentUsesMagnitude(incident.kind) ? 0.01 : 1}
                      max={incidentUsesMagnitude(incident.kind) ? 100 : 1}
                      step="0.1"
                      value={incident.magnitude}
                      disabled={!incidentUsesMagnitude(incident.kind)}
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
                    Event label
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
                <small>EVALUATION</small>
                <h2>
                  {mode === "interview"
                    ? "Evaluation criteria"
                    : "Pass criteria"}
                </h2>
              </div>
              <p>
                {mode === "interview"
                  ? "Choose what candidates can see and what stays in the private rubric."
                  : "Set the thresholds each run must meet."}
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
                <small>SHARE</small>
                <h2>Open or share</h2>
              </div>
              <ShieldCheck size={22} />
              {sectionCollapse("share")}
            </header>
            <div className="handoff-grid">
              <div className="handoff-local">
                <strong>Local share links</strong>
                <p>
                  {mode === "interview"
                    ? "The scenario stays in the URL. Candidate links exclude the private rubric. Nothing is uploaded."
                    : "This link stores the scenario in the URL. Nothing is uploaded."}
                </p>
                {localShare.error ? (
                  <p className="form-error" role="status">
                    {localShare.error}
                  </p>
                ) : localLinks ? (
                  <>
                    <CopyField
                      label="Interviewer link"
                      value={localLinks.interviewer}
                      copied={copied === "interviewer"}
                      onCopy={() =>
                        void copy("interviewer", localLinks.interviewer)
                      }
                      disabled={!validation.success}
                    />
                    <CopyField
                      label="Candidate link"
                      value={localLinks.candidate}
                      copied={copied === "candidate"}
                      onCopy={() =>
                        void copy("candidate", localLinks.candidate)
                      }
                      disabled={!validation.success}
                    />
                  </>
                ) : customLink ? (
                  <CopyField
                    label="Scenario link"
                    value={customLink}
                    copied={copied === "challenge"}
                    onCopy={() => void copy("challenge", customLink)}
                    disabled={!validation.success}
                  />
                ) : null}
              </div>
              <div className="handoff-canonical">
                <strong>Server-backed short link</strong>
                <p>
                  Create a shorter link with the online service. Local links
                  still work when it is unavailable.
                </p>
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={publishing || !validation.success}
                  onClick={() => void publish()}
                >
                  <CloudArrowUp size={16} />
                  {publishing ? "Creating link…" : "Create short link"}
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
                          ? "Candidate short link"
                          : "Scenario short link"
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
                        label="Interviewer short link"
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
              <span>Open in Lab</span>
              <strong>Load with the checkout architecture</strong>
              <ArrowRight size={20} />
            </button>
          </section>
        </form>
        <aside
          className="designer-summary"
          aria-label="Scenario completion summary"
        >
          <header>
            <span className="panel-index">SCENARIO SUMMARY</span>
            <strong>
              {completedSections}/{sectionStates.length} sections ready
            </strong>
            <div
              className="designer-progress"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={sectionStates.length}
              aria-valuenow={completedSections}
              aria-label="Scenario completion"
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
            <span>Scenario at a glance</span>
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
              Scenario ready <strong>Open the Lab</strong>{" "}
              <ArrowRight size={14} />
            </button>
          )}
          <footer>
            <ShieldCheck size={15} />
            <span>
              {mode === "interview"
                ? "Candidate links exclude the interviewer brief and hidden criteria."
                : "This draft is stored in your browser. Creating a short link sends the scenario to the online service."}
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
  const inputId = useId();
  return (
    <div className="copy-field-label">
      <label htmlFor={inputId}>{label}</label>
      <span className="copy-field">
        <input id={inputId} readOnly value={value} disabled={disabled} />
        <button type="button" onClick={onCopy} disabled={disabled}>
          {copied ? <Check size={15} /> : <Copy size={15} />}
          {copied ? "Copied" : "Copy"}
        </button>
      </span>
    </div>
  );
}
