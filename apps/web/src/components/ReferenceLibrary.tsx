import {
  ArrowSquareOut,
  Books,
  ClockCounterClockwise,
  Funnel,
  MagnifyingGlass,
  ShieldCheck,
} from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import {
  INCIDENT_CATALOG,
  type IncidentReference,
} from "../lib/incidentCatalog";
import {
  SYSTEM_DESIGN_CATALOG,
  type ReferenceStatus,
  type SystemDesignReference,
} from "../lib/systemDesignCatalog";

type ReferenceView = "systems" | "incidents";

const systemMatches = (
  reference: SystemDesignReference,
  query: string,
  status: "all" | ReferenceStatus,
): boolean => {
  if (status !== "all" && reference.status !== status) return false;
  if (!query) return true;
  return [
    reference.name,
    reference.operator,
    reference.domain,
    reference.workload,
    reference.guarantees,
    ...reference.topology,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
};

const incidentMatches = (
  reference: IncidentReference,
  query: string,
  family: string,
): boolean => {
  if (family !== "all" && !reference.componentFamilies.includes(family))
    return false;
  if (!query) return true;
  return [
    reference.name,
    reference.operator,
    reference.trigger,
    reference.propagation,
    reference.impact,
    ...reference.componentFamilies,
  ]
    .join(" ")
    .toLowerCase()
    .includes(query);
};

function SourceLinks({
  sources,
}: {
  sources: SystemDesignReference["sources"];
}) {
  return (
    <ul className="reference-sources">
      {sources.map((item) => (
        <li key={item.url}>
          <a href={item.url} target="_blank" rel="noreferrer">
            <span>
              <strong>{item.label}</strong>
              <small>{item.publisher}</small>
            </span>
            <ArrowSquareOut size={14} aria-hidden="true" />
          </a>
        </li>
      ))}
    </ul>
  );
}

function SystemReferenceDetail({
  reference,
}: {
  reference: SystemDesignReference;
}) {
  return (
    <article
      className="reference-detail"
      aria-label={`${reference.name} reference`}
    >
      <header>
        <span>{reference.operator}</span>
        <h3>{reference.name}</h3>
        <p>{reference.domain}</p>
        <div className="reference-badges" aria-label="Reference boundaries">
          <b>{reference.publishedSnapshot} snapshot</b>
          <b>{reference.status}</b>
          <b>{reference.scope}</b>
        </div>
      </header>

      <section>
        <span className="reference-section-label">Workload shape</span>
        <p>{reference.workload}</p>
      </section>

      <section>
        <span className="reference-section-label">
          Published component path
        </span>
        <ol
          className="reference-topology"
          aria-label="Simplified disclosed topology"
        >
          {reference.topology.map((stage, index) => (
            <li key={`${stage}-${index}`}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{stage}</strong>
            </li>
          ))}
        </ol>
        <small className="reference-boundary">
          This visual index contains only components disclosed by the cited
          source. It is not an invented complete production diagram.
        </small>
      </section>

      <div className="reference-fact-grid">
        <section>
          <span className="reference-section-label">Guarantees</span>
          <p>{reference.guarantees}</p>
        </section>
        <section>
          <span className="reference-section-label">Scale and failure</span>
          <p>{reference.scaleAndFailure}</p>
        </section>
      </div>

      <aside className="reference-caveat">
        <strong>Evidence boundary</strong>
        <p>{reference.caveat}</p>
      </aside>

      <section>
        <span className="reference-section-label">Primary sources</span>
        <SourceLinks sources={reference.sources} />
      </section>
    </article>
  );
}

function IncidentReferenceDetail({
  reference,
}: {
  reference: IncidentReference;
}) {
  const facts = [
    ["Trigger", reference.trigger],
    ["Propagation", reference.propagation],
    ["User impact", reference.impact],
    ["Recovery", reference.recovery],
  ] as const;
  return (
    <article
      className="reference-detail"
      aria-label={`${reference.name} incident`}
    >
      <header>
        <span>{reference.operator}</span>
        <h3>{reference.name}</h3>
        <p>{reference.date}</p>
        <div className="reference-badges">
          <b>{reference.evidenceKind.replaceAll("-", " ")}</b>
          <b>{reference.componentFamilies.length} component families</b>
        </div>
      </header>

      <section>
        <span className="reference-section-label">
          <ShieldCheck size={13} aria-hidden="true" /> Source-backed incident
          chain
        </span>
        <ol className="incident-chain">
          {facts.map(([label, detail], index) => (
            <li key={label}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <strong>{label}</strong>
                <p>{detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="reference-synthesis">
        <span className="reference-section-label">
          SystemForge prevention synthesis
        </span>
        <p>
          These are engineering deductions from the cited incident, not
          statements copied from the historical record.
        </p>
        <ul>
          {reference.preventionLessons.map((lesson) => (
            <li key={lesson}>{lesson}</li>
          ))}
        </ul>
      </section>

      <section>
        <span className="reference-section-label">
          Affected component families
        </span>
        <div className="reference-tags">
          {reference.componentFamilies.map((family) => (
            <span key={family}>{family}</span>
          ))}
        </div>
      </section>

      <section>
        <span className="reference-section-label">Primary sources</span>
        <SourceLinks sources={reference.sources} />
      </section>
    </article>
  );
}

export function ReferenceLibrary() {
  const [view, setView] = useState<ReferenceView>("systems");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | ReferenceStatus>("all");
  const [family, setFamily] = useState("all");
  const [selectedSystemId, setSelectedSystemId] = useState(
    SYSTEM_DESIGN_CATALOG[0]!.id,
  );
  const [selectedIncidentId, setSelectedIncidentId] = useState(
    INCIDENT_CATALOG[0]!.id,
  );
  const normalizedQuery = query.trim().toLowerCase();
  const systemResults = useMemo(
    () =>
      SYSTEM_DESIGN_CATALOG.filter((reference) =>
        systemMatches(reference, normalizedQuery, status),
      ),
    [normalizedQuery, status],
  );
  const incidentFamilies = useMemo(
    () =>
      [
        ...new Set(INCIDENT_CATALOG.flatMap((item) => item.componentFamilies)),
      ].sort(),
    [],
  );
  const incidentResults = useMemo(
    () =>
      INCIDENT_CATALOG.filter((reference) =>
        incidentMatches(reference, normalizedQuery, family),
      ),
    [family, normalizedQuery],
  );
  const selectedSystem =
    systemResults.find((item) => item.id === selectedSystemId) ??
    systemResults[0];
  const selectedIncident =
    incidentResults.find((item) => item.id === selectedIncidentId) ??
    incidentResults[0];
  const resultCount =
    view === "systems" ? systemResults.length : incidentResults.length;

  return (
    <div className="reference-library">
      <header className="reference-library__header">
        <div>
          <span>Production evidence library</span>
          <strong>How real systems are built and how they fail</strong>
          <p>
            {SYSTEM_DESIGN_CATALOG.length} disclosed system designs and{" "}
            {INCIDENT_CATALOG.length} primary-source incidents. Historical facts
            and SystemForge deductions stay visibly separate.
          </p>
        </div>
        <div className="reference-view-switch" aria-label="Reference type">
          <button
            type="button"
            aria-pressed={view === "systems"}
            onClick={() => setView("systems")}
          >
            <Books size={15} aria-hidden="true" /> Systems
          </button>
          <button
            type="button"
            aria-pressed={view === "incidents"}
            onClick={() => setView("incidents")}
          >
            <ClockCounterClockwise size={15} aria-hidden="true" /> Incidents
          </button>
        </div>
      </header>

      <div className="reference-toolbar">
        <label>
          <MagnifyingGlass size={14} aria-hidden="true" />
          <span>Search evidence</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={
              view === "systems"
                ? "Operator, workload, topology, guarantee"
                : "Operator, trigger, component, impact"
            }
          />
        </label>
        <label>
          <Funnel size={14} aria-hidden="true" />
          <span>
            {view === "systems" ? "Reference age" : "Component family"}
          </span>
          {view === "systems" ? (
            <select
              value={status}
              onChange={(event) =>
                setStatus(event.target.value as "all" | ReferenceStatus)
              }
            >
              <option value="all">All snapshots</option>
              <option value="current">Current</option>
              <option value="evolved">Evolved</option>
              <option value="historical">Historical</option>
            </select>
          ) : (
            <select
              value={family}
              onChange={(event) => setFamily(event.target.value)}
            >
              <option value="all">All component families</option>
              {incidentFamilies.map((item) => (
                <option value={item} key={item}>
                  {item}
                </option>
              ))}
            </select>
          )}
        </label>
        <output aria-live="polite">{resultCount} references</output>
      </div>

      <div className="reference-library__body">
        <nav
          aria-label={
            view === "systems" ? "System designs" : "Incident postmortems"
          }
        >
          {(view === "systems" ? systemResults : incidentResults).map(
            (item, index) => {
              const active =
                view === "systems"
                  ? item.id === selectedSystem?.id
                  : item.id === selectedIncident?.id;
              return (
                <button
                  type="button"
                  className={active ? "active" : ""}
                  aria-current={active ? "true" : undefined}
                  key={item.id}
                  onClick={() =>
                    view === "systems"
                      ? setSelectedSystemId(item.id)
                      : setSelectedIncidentId(item.id)
                  }
                >
                  <span>{String(index + 1).padStart(2, "0")}</span>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {view === "systems"
                        ? `${(item as SystemDesignReference).operator} · ${(item as SystemDesignReference).publishedSnapshot}`
                        : `${(item as IncidentReference).operator} · ${(item as IncidentReference).date}`}
                    </small>
                  </span>
                </button>
              );
            },
          )}
          {resultCount === 0 ? (
            <div className="reference-empty">
              <strong>No matching evidence</strong>
              <p>Clear the search or broaden the filter.</p>
            </div>
          ) : null}
        </nav>

        {view === "systems" && selectedSystem ? (
          <SystemReferenceDetail reference={selectedSystem} />
        ) : null}
        {view === "incidents" && selectedIncident ? (
          <IncidentReferenceDetail reference={selectedIncident} />
        ) : null}
      </div>
    </div>
  );
}
