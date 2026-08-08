import {
  ArrowCounterClockwise,
  BookmarkSimple,
  Crosshair,
  Flask,
  MagnifyingGlass,
  Play,
  Scales,
  TextAa,
  WarningOctagon,
  X,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useLabStore } from "../store/useLabStore";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onOpenDecisionWorkbench: () => void;
}

interface PaletteCommand {
  id: string;
  label: string;
  detail: string;
  icon: typeof Play;
  disabled?: boolean;
  run: () => void;
}

const DENSITY_KEY = "systemforge:density";

export function CommandPalette({
  open,
  onClose,
  onOpenDecisionWorkbench,
}: CommandPaletteProps) {
  const scenario = useLabStore((state) => state.scenario);
  const architecture = useLabStore((state) => state.architecture);
  const selectedNodeId = useLabStore((state) => state.selectedNodeId);
  const runState = useLabStore((state) => state.runState);
  const runLocal = useLabStore((state) => state.runLocal);
  const setScenario = useLabStore((state) => state.setScenario);
  const selectNode = useLabStore((state) => state.setSelectedNodeId);
  const setWorkspaceMode = useLabStore((state) => state.setWorkspaceMode);
  const undo = useLabStore((state) => state.undoArchitecture);
  const canUndo = useLabStore((state) => state.architectureUndo.length > 0);
  const saveSnapshot = useLabStore((state) => state.saveArchitectureSnapshot);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const lowRedundancy = architecture.nodes.find(
      (node) =>
        ["api", "database", "load-balancer", "queue"].includes(node.kind) &&
        node.config.instances + node.config.replicas < 2,
    );
    const outageTarget =
      architecture.nodes.find((node) => node.id === selectedNodeId) ??
      architecture.nodes.find((node) => node.kind === "database");
    return [
      {
        id: "run",
        label: "Run local simulation",
        detail: "Execute the current mission in a disposable browser worker.",
        icon: Play,
        disabled: runState === "running",
        run: () => {
          setWorkspaceMode("run");
          void runLocal();
        },
      },
      {
        id: "compare",
        label: "Compare architecture candidates",
        detail: "Open bounded solver, robustness and decision evidence tools.",
        icon: Scales,
        run: onOpenDecisionWorkbench,
      },
      {
        id: "undo",
        label: "Undo architecture edit",
        detail: "Restore the previous topology or configuration state.",
        icon: ArrowCounterClockwise,
        disabled: !canUndo,
        run: undo,
      },
      {
        id: "snapshot",
        label: "Save named architecture snapshot",
        detail: "Preserve the current state in this browser.",
        icon: BookmarkSimple,
        run: () =>
          saveSnapshot(`Manual snapshot ${new Date().toLocaleTimeString()}`),
      },
      {
        id: "spof",
        label: "Inspect low-redundancy component",
        detail: lowRedundancy
          ? `Select ${lowRedundancy.name} in the configuration inspector.`
          : "No obvious low-redundancy service was found.",
        icon: Crosshair,
        disabled: !lowRedundancy,
        run: () => {
          if (!lowRedundancy) return;
          setWorkspaceMode("build");
          selectNode(lowRedundancy.id);
        },
      },
      {
        id: "outage",
        label: "Arm a selected-node outage",
        detail: outageTarget
          ? `Add a reversible node-failure incident for ${outageTarget.name}.`
          : "Select a component before arming an outage.",
        icon: WarningOctagon,
        disabled: !outageTarget || scenario.incidents.length >= 40,
        run: () => {
          if (!outageTarget) return;
          setScenario({
            ...scenario,
            incidents: [
              ...scenario.incidents,
              {
                id: `command-outage-${crypto.randomUUID()}`,
                atSecond: Math.max(
                  1,
                  Math.round(scenario.workload.durationSeconds * 0.45),
                ),
                kind: "node-failure",
                magnitude: 1,
                durationSeconds: Math.max(
                  1,
                  Math.round(scenario.workload.durationSeconds * 0.2),
                ),
                targetId: outageTarget.id,
                label: `${outageTarget.name} unavailable`,
              },
            ],
          });
        },
      },
      {
        id: "density",
        label: "Toggle comfortable information density",
        detail:
          "Increase essential labels and control text without changing the visual system.",
        icon: TextAa,
        run: () => {
          const current =
            document.documentElement.dataset.systemforgeDensity ?? "compact";
          const next = current === "comfortable" ? "compact" : "comfortable";
          document.documentElement.dataset.systemforgeDensity = next;
          localStorage.setItem(DENSITY_KEY, next);
        },
      },
      {
        id: "robustness",
        label: "Open multi-seed robustness",
        detail: "Use nine bounded seeds to expose modeled outcome variance.",
        icon: Flask,
        run: onOpenDecisionWorkbench,
      },
    ];
  }, [
    architecture.nodes,
    canUndo,
    onOpenDecisionWorkbench,
    runLocal,
    runState,
    saveSnapshot,
    scenario,
    selectNode,
    selectedNodeId,
    setScenario,
    setWorkspaceMode,
    undo,
  ]);
  const visibleCommands = commands.filter((command) =>
    `${command.label} ${command.detail}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );

  if (!open) return null;
  return (
    <div
      className="command-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-title"
        className="command-palette"
      >
        <header>
          <MagnifyingGlass size={17} />
          <label id="command-title">
            <span>SystemForge commands</span>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Run, compare, inspect, inject…"
            />
          </label>
          <button
            type="button"
            aria-label="Close command palette"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div>
          {visibleCommands.map(
            ({ id, label, detail, icon: Icon, disabled, run }) => (
              <button
                type="button"
                disabled={disabled}
                key={id}
                onClick={() => {
                  run();
                  onClose();
                }}
              >
                <Icon size={17} />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </button>
            ),
          )}
          {visibleCommands.length === 0 ? (
            <p>No command matches “{query}”.</p>
          ) : null}
        </div>
        <footer>
          <span>Enter to activate</span>
          <span>Esc to close</span>
          <span>Ctrl Shift P to reopen</span>
        </footer>
      </section>
    </div>
  );
}
