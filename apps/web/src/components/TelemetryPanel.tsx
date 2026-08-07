import { useEffect, useRef } from "react";
import {
  CheckCircle,
  Info,
  Warning,
  WarningOctagon,
} from "@phosphor-icons/react";
import type { SimulationResult } from "@systemforge/contracts";

interface TelemetryPanelProps {
  result: SimulationResult | null;
  selectedEventId: string | null;
  onSelectEvent: (id: string) => void;
}

function TelemetryCanvas({ result }: { result: SimulationResult }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    context.scale(ratio, ratio);
    context.clearRect(0, 0, width, height);
    const frames = result.frames;
    const maxRps = Math.max(...frames.map((frame) => frame.rps), 1);
    const maxLatency = Math.max(
      ...frames.map((frame) => frame.p95LatencyMs),
      1,
    );
    const maxError = Math.max(...frames.map((frame) => frame.errorRate), 1);
    const draw = (values: number[], max: number, color: string) => {
      context.beginPath();
      context.lineWidth = 1.5;
      context.strokeStyle = color;
      values.forEach((value, index) => {
        const x = (index / Math.max(1, values.length - 1)) * width;
        const y = height - 8 - (value / max) * (height - 16);
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
    };
    draw(
      frames.map((frame) => frame.rps),
      maxRps,
      "#7adbd0",
    );
    draw(
      frames.map((frame) => frame.p95LatencyMs),
      maxLatency,
      "#e8bd65",
    );
    draw(
      frames.map((frame) => frame.errorRate),
      maxError,
      "#f06b5c",
    );
  }, [result]);
  return (
    <canvas
      ref={canvasRef}
      className="telemetry-canvas"
      aria-label="Traffic, latency and error-rate telemetry chart"
    />
  );
}

export function TelemetryPanel({
  result,
  selectedEventId,
  onSelectEvent,
}: TelemetryPanelProps) {
  if (!result) {
    return (
      <section className="telemetry-panel telemetry-panel--empty">
        <div>
          <Info size={18} weight="duotone" />
          <strong>Simulation timeline</strong>
        </div>
        <p>
          Run locally to generate telemetry and causal evidence. Server
          availability is not required.
        </p>
      </section>
    );
  }
  return (
    <section className="telemetry-panel" aria-label="Simulation telemetry">
      <div className="event-log">
        <header>
          <strong>Events</strong>
          <span>{result.events.length} causal changes</span>
        </header>
        <div className="event-log__list">
          {result.events.map((event) => {
            const Icon =
              event.severity === "critical"
                ? WarningOctagon
                : event.severity === "warning"
                  ? Warning
                  : CheckCircle;
            return (
              <button
                type="button"
                className={selectedEventId === event.id ? "selected" : ""}
                key={event.id}
                onClick={() => onSelectEvent(event.id)}
              >
                <time>
                  {String(Math.floor(event.second / 60)).padStart(2, "0")}:
                  {String(event.second % 60).padStart(2, "0")}
                </time>
                <Icon size={14} weight="fill" aria-hidden="true" />
                <span>{event.title}</span>
              </button>
            );
          })}
        </div>
      </div>
      <div className="telemetry-chart">
        <div className="telemetry-legend">
          <span className="legend-rps">RPS</span>
          <span className="legend-latency">p95 latency</span>
          <span className="legend-error">Error rate</span>
        </div>
        <TelemetryCanvas result={result} />
        <div className="timeline-events">
          {result.events.slice(0, 4).map((event) => (
            <span
              key={event.id}
              style={{
                left: `${(event.second / Math.max(1, result.frames.length - 1)) * 100}%`,
              }}
            >
              {event.title}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
