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
import { componentOwnsState } from "@systemforge/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { lintArchitecture } from "../lib/architectureLint";
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
  const [activeIndex, setActiveIndex] = useState(0);
  const modifierLabel =
    typeof navigator !== "undefined" &&
    /Mac|iPhone|iPad/.test(navigator.platform)
      ? "⌘ ⇧ P"
      : "Ctrl Shift P";
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    setQuery("");
    setActiveIndex(0);
    inputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [href]',
        ),
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previous?.focus();
    };
  }, [onClose, open]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const graphErrorCount = lintArchitecture(scenario, architecture).filter(
      (issue) => issue.severity === "error",
    ).length;
    const lowRedundancy = architecture.nodes.find(
      (node) =>
        ["api", "database", "load-balancer", "queue"].includes(node.kind) &&
        (componentOwnsState(node.kind)
          ? node.config.replicas < 1
          : node.config.instances < 2),
    );
    const outageTarget =
      architecture.nodes.find((node) => node.id === selectedNodeId) ??
      architecture.nodes.find((node) => node.kind === "database");
    return [
      {
        id: "run",
        label: "Run locally",
        detail: graphErrorCount
          ? `Resolve ${graphErrorCount} blocking graph-lint error${graphErrorCount === 1 ? "" : "s"} first.`
          : "Run this scenario in the browser.",
        icon: Play,
        disabled: runState === "running" || graphErrorCount > 0,
        run: () => {
          setWorkspaceMode("run");
          void runLocal();
        },
      },
      {
        id: "compare",
        label: "Compare designs",
        detail: "Search bounded architecture changes.",
        icon: Scales,
        run: onOpenDecisionWorkbench,
      },
      {
        id: "undo",
        label: "Undo change",
        detail: "Restore the previous topology.",
        icon: ArrowCounterClockwise,
        disabled: !canUndo,
        run: undo,
      },
      {
        id: "snapshot",
        label: "Save snapshot",
        detail: "Save this topology in the browser.",
        icon: BookmarkSimple,
        run: () =>
          saveSnapshot(`Manual snapshot ${new Date().toLocaleTimeString()}`),
      },
      {
        id: "spof",
        label: "Inspect low redundancy",
        detail: lowRedundancy
          ? `Select ${lowRedundancy.name}.`
          : "No component with fewer than two configured copies was found.",
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
        label: "Schedule node outage",
        detail: outageTarget
          ? `Add a scheduled node-failure incident for ${outageTarget.name}.`
          : "Select a component before scheduling an outage.",
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
        label: "Toggle text size",
        detail: "Switch between compact and comfortable text.",
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
        label: "Run seed sweep",
        detail: "Compare this design across nine seeds.",
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
  const enabledIndices = visibleCommands.flatMap((command, index) =>
    command.disabled ? [] : [index],
  );
  useEffect(() => {
    if (!open || enabledIndices.includes(activeIndex)) return;
    setActiveIndex(enabledIndices[0] ?? 0);
  }, [activeIndex, enabledIndices, open]);
  const moveSelection = (direction: 1 | -1) => {
    if (!enabledIndices.length) return;
    const currentPosition = enabledIndices.indexOf(activeIndex);
    const nextPosition =
      currentPosition === -1
        ? direction === 1
          ? 0
          : enabledIndices.length - 1
        : (currentPosition + direction + enabledIndices.length) %
          enabledIndices.length;
    setActiveIndex(enabledIndices[nextPosition] ?? 0);
  };
  const activateSelection = () => {
    const command = visibleCommands[activeIndex];
    if (!command || command.disabled) return;
    command.run();
    onClose();
  };

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
        ref={dialogRef}
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
              role="combobox"
              aria-controls="systemforge-command-list"
              aria-expanded="true"
              aria-activedescendant={
                visibleCommands[activeIndex]
                  ? `systemforge-command-${visibleCommands[activeIndex].id}`
                  : undefined
              }
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  moveSelection(1);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  moveSelection(-1);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  activateSelection();
                }
              }}
              placeholder="Search commands"
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
        <div id="systemforge-command-list" role="listbox">
          {visibleCommands.map(
            ({ id, label, detail, icon: Icon, disabled, run }, index) => (
              <button
                id={`systemforge-command-${id}`}
                type="button"
                role="option"
                tabIndex={-1}
                aria-selected={index === activeIndex}
                disabled={disabled}
                key={id}
                className={index === activeIndex ? "active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
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
          <span>Arrow keys to choose · Enter to activate</span>
          <span>Esc to close</span>
          <span>{modifierLabel} to reopen</span>
        </footer>
      </section>
    </div>
  );
}
