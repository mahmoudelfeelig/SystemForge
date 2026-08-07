import {
  ArrowLeft,
  CloudArrowUp,
  Copy,
  EyeSlash,
  Plus,
  Trash,
  UsersThree,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type { Requirement, Scenario } from "@systemforge/contracts";
import { DEFAULT_ARCHITECTURE, DEFAULT_SCENARIO } from "@systemforge/sim-core";
import { shareScenario } from "../lib/api";
import { encodeLocalShare, interviewShareLinks } from "../lib/share";
import { useLabStore } from "../store/useLabStore";

interface ScenarioDesignerPageProps {
  mode: "custom" | "interview";
}

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

export function ScenarioDesignerPage({ mode }: ScenarioDesignerPageProps) {
  const navigate = useNavigate();
  const setScenario = useLabStore((state) => state.setScenario);
  const [scenario, setDraft] = useState<Scenario>(() => ({
    ...structuredClone(DEFAULT_SCENARIO),
    id: `${mode}-${Date.now()}`,
    title:
      mode === "interview"
        ? "Distributed systems interview"
        : "Untitled systems challenge",
    summary:
      mode === "interview"
        ? "The candidate should discover the important constraints before committing to an architecture."
        : "A custom workload and requirement set.",
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
              "Evaluate whether the candidate discovers durability, consistency, regional data and overload constraints.",
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
  const links = useMemo(
    () =>
      mode === "interview"
        ? interviewShareLinks(scenario, DEFAULT_ARCHITECTURE)
        : null,
    [mode, scenario],
  );

  const updateRequirement = (id: string, patch: Partial<Requirement>) =>
    setDraft((current) => ({
      ...current,
      requirements: current.requirements.map((requirement) =>
        requirement.id === id ? { ...requirement, ...patch } : requirement,
      ),
    }));
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
    window.setTimeout(() => setCopied(null), 1800);
  };
  const openLab = () => {
    localStorage.setItem(
      "systemforge:draft",
      JSON.stringify({ scenario, architecture: DEFAULT_ARCHITECTURE }),
    );
    setScenario(scenario);
    void navigate("/lab");
  };
  const customLink = `${window.location.origin}/lab#share=${encodeLocalShare({ scenario, architecture: DEFAULT_ARCHITECTURE, role: "participant" })}`;
  const publish = async () => {
    setPublishing(true);
    setPublishError(null);
    try {
      const receipt = await shareScenario(scenario, DEFAULT_ARCHITECTURE);
      setCanonicalLinks({
        participant: receipt.candidateUrl ?? receipt.url,
        ...(receipt.hostToken
          ? {
              interviewer: `${receipt.url}?hostToken=${encodeURIComponent(receipt.hostToken)}`,
            }
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
      <header>
        <Link to="/">
          <ArrowLeft size={17} /> SystemForge
        </Link>
        <div>
          <span>
            {mode === "interview" ? "Interview studio" : "Challenge studio"}
          </span>
          <strong>{scenario.title}</strong>
        </div>
        <button
          className="button button--primary"
          type="button"
          onClick={openLab}
        >
          Open in lab
        </button>
      </header>
      <main>
        <section className="designer-intro">
          <span className="eyebrow">
            {mode === "interview" ? (
              <UsersThree size={16} />
            ) : (
              <Plus size={16} />
            )}{" "}
            {mode} scenario
          </span>
          <h1>
            {mode === "interview"
              ? "Give the problem shape without giving away its requirements."
              : "Define exactly what a successful system must survive."}
          </h1>
          <p>
            Both flows compile into the same versioned scenario contract.
            Visibility and facilitation rules change what each participant sees.
          </p>
        </section>
        <form
          className="designer-grid"
          onSubmit={(event) => event.preventDefault()}
        >
          <section className="form-panel">
            <header>
              <span>Brief</span>
              <small>Visible context</small>
            </header>
            <label>
              Title
              <input
                value={scenario.title}
                maxLength={120}
                onChange={(event) =>
                  setDraft({ ...scenario, title: event.target.value })
                }
              />
            </label>
            <label>
              Summary
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
              <>
                <label>
                  Candidate brief
                  <textarea
                    value={scenario.interview.candidateBrief}
                    rows={6}
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
                <label className="private-field">
                  <span>
                    <EyeSlash size={15} /> Interviewer-only notes
                  </span>
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
              </>
            ) : null}
          </section>
          <section className="form-panel">
            <header>
              <span>Workload</span>
              <small>Modeled demand</small>
            </header>
            <div className="form-columns">
              <label>
                Base RPS
                <input
                  type="number"
                  min="1"
                  value={scenario.workload.baseRps}
                  onChange={(event) =>
                    setDraft({
                      ...scenario,
                      workload: {
                        ...scenario.workload,
                        baseRps: Number(event.target.value),
                      },
                    })
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
                    setDraft({
                      ...scenario,
                      workload: {
                        ...scenario.workload,
                        peakRps: Number(event.target.value),
                      },
                    })
                  }
                />
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
                    setDraft({
                      ...scenario,
                      workload: {
                        ...scenario.workload,
                        readRatio: Number(event.target.value),
                      },
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
                    setDraft({
                      ...scenario,
                      workload: {
                        ...scenario.workload,
                        durationSeconds: Number(event.target.value),
                      },
                    })
                  }
                />
              </label>
            </div>
          </section>
          <section className="form-panel requirements-editor">
            <header>
              <span>Requirements</span>
              <button
                type="button"
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
                <Plus size={15} /> Add
              </button>
            </header>
            {scenario.requirements.map((requirement) => (
              <div className="requirement-row" key={requirement.id}>
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
                  <option value="availability">Availability</option>
                  <option value="p95LatencyMs">p95 latency</option>
                  <option value="p99LatencyMs">p99 latency</option>
                  <option value="errorRate">Error rate</option>
                  <option value="monthlyCostEur">Monthly cost</option>
                  <option value="dataLoss">Data loss</option>
                  <option value="consistencyViolations">
                    Consistency violations
                  </option>
                  <option value="throughputRps">Throughput</option>
                  <option value="queueDepth">Queue depth</option>
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
                  <Trash size={15} />
                </button>
              </div>
            ))}
          </section>
          <section className="form-panel share-panel">
            <header>
              <span>Share challenge</span>
              <small>Local first</small>
            </header>
            {links ? (
              <>
                <label>
                  Local interviewer link
                  <div className="copy-field">
                    <input readOnly value={links.interviewer} />
                    <button
                      type="button"
                      onClick={() =>
                        void copy("interviewer", links.interviewer)
                      }
                    >
                      <Copy size={15} />{" "}
                      {copied === "interviewer" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </label>
                <label>
                  Local candidate link
                  <div className="copy-field">
                    <input readOnly value={links.candidate} />
                    <button
                      type="button"
                      onClick={() => void copy("candidate", links.candidate)}
                    >
                      <Copy size={15} />{" "}
                      {copied === "candidate" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </label>
              </>
            ) : (
              <label>
                Local challenge link
                <div className="copy-field">
                  <input readOnly value={customLink} />
                  <button
                    type="button"
                    onClick={() => void copy("challenge", customLink)}
                  >
                    <Copy size={15} />{" "}
                    {copied === "challenge" ? "Copied" : "Copy"}
                  </button>
                </div>
              </label>
            )}
            <button
              className="button button--secondary publish-button"
              type="button"
              disabled={publishing}
              onClick={() => void publish()}
            >
              <CloudArrowUp size={16} />
              {publishing ? "Publishing…" : "Create canonical short link"}
            </button>
            {publishError ? (
              <p className="form-error">
                {publishError} Local links above remain available.
              </p>
            ) : null}
            {canonicalLinks ? (
              <div className="canonical-links">
                <label>
                  {mode === "interview"
                    ? "Canonical candidate link"
                    : "Canonical challenge link"}
                  <div className="copy-field">
                    <input readOnly value={canonicalLinks.participant} />
                    <button
                      type="button"
                      onClick={() =>
                        void copy(
                          "canonical-participant",
                          canonicalLinks.participant,
                        )
                      }
                    >
                      <Copy size={15} />
                      {copied === "canonical-participant" ? "Copied" : "Copy"}
                    </button>
                  </div>
                </label>
                {canonicalLinks.interviewer ? (
                  <label>
                    Canonical interviewer link
                    <div className="copy-field">
                      <input readOnly value={canonicalLinks.interviewer} />
                      <button
                        type="button"
                        onClick={() =>
                          void copy(
                            "canonical-interviewer",
                            canonicalLinks.interviewer!,
                          )
                        }
                      >
                        <Copy size={15} />
                        {copied === "canonical-interviewer" ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </label>
                ) : null}
              </div>
            ) : null}
            <p>
              Canonical links use the service when it has capacity. Local links
              require no backend.
            </p>
          </section>
        </form>
      </main>
    </div>
  );
}
