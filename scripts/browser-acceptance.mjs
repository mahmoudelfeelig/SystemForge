import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const webRoot = resolve(root, "apps/web");
const vite = resolve(webRoot, "node_modules/vite/bin/vite.js");
const prepareSitesBuild = resolve(webRoot, "scripts/prepare-sites-build.mjs");
const artifactsDirectory = resolve(root, "test-results/browser");
const BUILD_TIMEOUT_MS = 120_000;
const ASSET_PREPARATION_TIMEOUT_MS = 60_000;
const PROCESS_CLEANUP_TIMEOUT_MS = 10_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const report = {
  startedAt: new Date().toISOString(),
  browser: null,
  origin: null,
  routes: [],
  interactions: [],
  screenshots: [],
  consoleErrors: [],
  expectedOfflineConsoleErrors: [],
  networkErrors: [],
  expectedOfflineNetworkErrors: [],
  acceptanceDefects: [],
  result: "failed",
};

const commandOutput = (child) => {
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    output += String(chunk);
  });
  return () => output;
};

const waitForProcessStop = (child, label, timeoutMs) =>
  new Promise((resolvePromise, reject) => {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) {
      resolvePromise();
      return;
    }
    const timeout = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not stop within ${timeoutMs} ms.`));
    }, timeoutMs);
    const cleanup = () => {
      globalThis.clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });

const requestProcessTreeTermination = (child) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  if (process.platform === "win32") {
    const terminated = spawnSync(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore" },
    );
    if (terminated.error) throw terminated.error;
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
};

const terminateProcessTree = async (child, label) => {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null)
    return;
  requestProcessTreeTermination(child);
  await waitForProcessStop(child, label, PROCESS_CLEANUP_TIMEOUT_MS);
};

const waitForExit = async (child, label, timeoutMs) => {
  let timeout;
  try {
    await Promise.race([
      new Promise((resolvePromise, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => {
          if (code === 0) resolvePromise();
          else
            reject(
              new Error(
                `${label} exited with ${code ?? signal ?? "an unknown status"}.`,
              ),
            );
        });
      }),
      new Promise((_, reject) => {
        timeout = globalThis.setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs} ms.`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    await terminateProcessTree(child, label);
    throw error;
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
};

const reservePort = async () => {
  const server = createServer();
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise((resolvePromise, reject) =>
    server.close((error) => (error ? reject(error) : resolvePromise())),
  );
  return port;
};

const waitForHttp = async (url, child, output) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`Preview stopped before it was ready.\n${output()}`);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
    } catch {
      // The preview may still be binding its port.
    }
    await delay(100);
  }
  throw new Error(`Preview did not become ready.\n${output()}`);
};

const edgeCandidates = () => {
  if (process.platform === "win32")
    return [
      join(
        process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)",
        "Microsoft/Edge/Application/msedge.exe",
      ),
      join(
        process.env.PROGRAMFILES ?? "C:\\Program Files",
        "Microsoft/Edge/Application/msedge.exe",
      ),
      join(
        process.env.LOCALAPPDATA ?? "",
        "Microsoft/Edge/Application/msedge.exe",
      ),
    ];
  return [
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/opt/microsoft/msedge/msedge",
  ];
};

const findEdge = async () => {
  for (const candidate of edgeCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep checking the known Microsoft Edge locations.
    }
  }
  throw new Error(
    `Microsoft Edge was not found. Checked: ${edgeCandidates().join(", ")}`,
  );
};

class CdpClient {
  constructor(webSocketUrl) {
    const WebSocketConstructor = globalThis.WebSocket;
    if (!WebSocketConstructor)
      throw new Error("This Node runtime does not provide WebSocket.");
    this.socket = new WebSocketConstructor(webSocketUrl);
    this.sequence = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect(timeoutMs = CDP_CONNECT_TIMEOUT_MS) {
    await new Promise((resolvePromise, reject) => {
      const timeout = globalThis.setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `CDP WebSocket connection timed out after ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      const cleanup = () => {
        globalThis.clearTimeout(timeout);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolvePromise();
      };
      const onError = (error) => {
        cleanup();
        reject(error);
      };
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        globalThis.clearTimeout(pending.timeout);
        if (message.error)
          pending.reject(
            new Error(`${message.error.message} (${message.error.code})`),
          );
        else pending.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? [])
        listener(message.params ?? {});
    });
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? [];
    listeners.push(listener);
    this.listeners.set(method, listeners);
  }

  call(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolvePromise, reject) => {
      const timeout = globalThis.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out.`));
      }, 20_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

const readDevToolsPort = async (profileDirectory, edge, output) => {
  const file = join(profileDirectory, "DevToolsActivePort");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (edge.exitCode !== null)
      throw new Error(
        `Microsoft Edge stopped before CDP was ready.\n${output()}`,
      );
    try {
      const [port] = (await readFile(file, "utf8")).trim().split(/\r?\n/);
      if (port && Number.isInteger(Number(port))) return Number(port);
    } catch {
      // Edge writes the endpoint after its isolated profile is ready.
    }
    await delay(100);
  }
  throw new Error(`Microsoft Edge did not expose CDP.\n${output()}`);
};

const openPage = async (port, url) => {
  const response = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
    { method: "PUT", signal: AbortSignal.timeout(5_000) },
  );
  if (!response.ok)
    throw new Error(`CDP target creation returned ${response.status}.`);
  return response.json();
};

const valueFromEvaluation = (result) => {
  if (result.exceptionDetails)
    throw new Error(
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        "Browser evaluation failed.",
    );
  return result.result?.value;
};

const evaluate = async (client, expression, awaitPromise = false) =>
  valueFromEvaluation(
    await client.call("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    }),
  );

const waitFor = async (client, expression, label, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(client, expression)) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

let navigationSequence = 0;
const navigate = async (client, url, readyText) => {
  const marker = `acceptance-${++navigationSequence}`;
  await evaluate(
    client,
    `document.documentElement.dataset.acceptanceNavigation = ${JSON.stringify(marker)}`,
  );
  const navigation = await client.call("Page.navigate", { url });
  if (navigation.errorText)
    throw new Error(`Could not navigate to ${url}: ${navigation.errorText}`);
  try {
    await waitFor(
      client,
      `document.readyState === "complete"
        && document.documentElement.dataset.acceptanceNavigation !== ${JSON.stringify(marker)}
        && document.body?.innerText.toLowerCase().includes(${JSON.stringify(readyText.toLowerCase())})`,
      `${url} to render ${readyText}`,
    );
    await evaluate(
      client,
      "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      true,
    );
  } catch (error) {
    const diagnostic = await evaluate(
      client,
      `({ url: location.href, title: document.title, readyState: document.readyState, body: document.body?.innerText.slice(0, 600) })`,
    );
    throw new Error(
      `${error instanceof Error ? error.message : String(error)} Browser state: ${JSON.stringify(diagnostic)}`,
      { cause: error },
    );
  }
};

const clickControl = async (client, label) => {
  const clicked = await evaluate(
    client,
    `(() => {
      const wanted = ${JSON.stringify(label)}.toLowerCase();
      const controls = [...document.querySelectorAll("button, a[href], [role='button']")];
      const control = controls.find((element) => {
        const name = (element.getAttribute("aria-label") || element.textContent || "")
          .replace(/\\s+/g, " ").trim().toLowerCase();
        return !element.disabled && (name === wanted || name.includes(wanted));
      });
      if (!control) return false;
      control.click();
      return true;
    })()`,
  );
  assert.equal(clicked, true, `Could not find enabled control ${label}.`);
};

const clickControlWithin = async (client, containerSelector, label) => {
  const clicked = await evaluate(
    client,
    `(() => {
      const container = document.querySelector(${JSON.stringify(containerSelector)});
      if (!container) return false;
      const wanted = ${JSON.stringify(label)}.toLowerCase();
      const control = [...container.querySelectorAll("button, a[href], [role='button']")]
        .find((element) => {
          const name = (element.getAttribute("aria-label") || element.textContent || "")
            .replace(/\\s+/g, " ").trim().toLowerCase();
          return !element.disabled && (name === wanted || name.includes(wanted));
        });
      if (!control) return false;
      control.click();
      return true;
    })()`,
  );
  assert.equal(
    clicked,
    true,
    `Could not find enabled control ${label} inside ${containerSelector}.`,
  );
};

const openDecisionWorkbench = async (client) => {
  await clickControl(client, "Compare");
  await waitFor(
    client,
    'document.querySelector("[role=dialog] #decision-tab-history") !== null',
    "the loaded decision workbench",
  );
};

const labeledFieldExpression = (label, body) => `(() => {
  const wanted = ${JSON.stringify(label)}.toLowerCase();
  const field = [...document.querySelectorAll("input, textarea, select")].find((element) => {
    const labelledBy = (element.getAttribute("aria-labelledby") || "")
      .split(/\\s+/).filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent || "").join(" ");
    const enclosingLabel = element.closest("label")?.textContent || "";
    const explicitLabel = element.id
      ? document.querySelector("label[for='" + CSS.escape(element.id) + "']")?.textContent || ""
      : "";
    const name = (element.getAttribute("aria-label") || labelledBy || explicitLabel || enclosingLabel)
      .replace(/\\s+/g, " ").trim().toLowerCase();
    return name === wanted || name.startsWith(wanted);
  });
  if (!field) return null;
  ${body}
})()`;

const setLabeledField = async (client, label, value) => {
  const updated = await evaluate(
    client,
    labeledFieldExpression(
      label,
      `const descriptor = Object.getOwnPropertyDescriptor(
        field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
          : field instanceof HTMLSelectElement ? HTMLSelectElement.prototype
            : HTMLInputElement.prototype,
        "value",
      );
      descriptor?.set?.call(field, ${JSON.stringify(value)});
      field.dispatchEvent(new Event("input", { bubbles: true }));
      field.dispatchEvent(new Event("change", { bubbles: true }));
      return field.value;`,
    ),
  );
  assert.notEqual(updated, null, `Could not find field ${label}.`);
  await waitFor(
    client,
    labeledFieldExpression(
      label,
      `return String(field.value) === ${JSON.stringify(String(value))};`,
    ),
    `${label} to retain ${String(value)}`,
  );
};

const readLabeledField = async (client, label) => {
  const value = await evaluate(
    client,
    labeledFieldExpression(label, "return field.value;"),
  );
  assert.notEqual(value, null, `Could not find field ${label}.`);
  return value;
};

const injectJsonFile = async (client, inputIndex, name, contents) => {
  const injected = await evaluate(
    client,
    `(() => {
      const input = [...document.querySelectorAll("input[type='file']")][${inputIndex}];
      if (!input || input.disabled) return false;
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(contents)}], ${JSON.stringify(name)}, {
        type: "application/json",
      }));
      input.files = transfer.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`,
  );
  assert.equal(injected, true, `Could not inject replay file ${name}.`);
};

const waitForDownloadedJson = async (directory, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const names = await readdir(directory).catch(() => []);
    const completed = names.find(
      (name) => name.endsWith("-replay.json") && !name.endsWith(".crdownload"),
    );
    if (completed) return join(directory, completed);
    await delay(100);
  }
  throw new Error("Timed out waiting for the portable replay bundle download.");
};

const auditPage = async (client, route, viewport) => {
  const audit = await evaluate(
    client,
    `(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      };
      const accessibleName = (element) => {
        const labelledBy = (element.getAttribute("aria-labelledby") || "")
          .split(/\\s+/).filter(Boolean)
          .map((id) => document.getElementById(id)?.textContent || "").join(" ");
        const label = element.id
          ? document.querySelector("label[for='" + CSS.escape(element.id) + "']")?.textContent || ""
          : element.closest("label")?.textContent || "";
        return (element.getAttribute("aria-label") || labelledBy || label || element.getAttribute("title") || element.textContent || "").trim();
      };
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id).filter(Boolean);
      const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
      const interactive = [...document.querySelectorAll("button, a[href], input:not([type='hidden']), select, textarea, [role='button'], [role='link']")]
        .filter(visible);
      const unnamedControls = interactive
        .filter((element) => !accessibleName(element))
        .map((element) => element.outerHTML.slice(0, 180));
      return {
        title: document.title,
        mains: document.querySelectorAll("main").length,
        duplicateIds,
        unnamedControls,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    })()`,
  );
  const violations = [];
  if (!audit.title) violations.push("document title is empty");
  if (audit.mains !== 1)
    violations.push(`expected one main landmark, found ${audit.mains}`);
  if (audit.duplicateIds.length)
    violations.push(`duplicate IDs: ${audit.duplicateIds.join(", ")}`);
  if (audit.unnamedControls.length)
    violations.push(`unnamed controls: ${audit.unnamedControls.join(" | ")}`);
  if (audit.horizontalOverflow)
    violations.push(
      `page overflow ${audit.scrollWidth}px at ${audit.viewportWidth}px`,
    );
  report.routes.push({ route, viewport, ...audit, violations });
  assert.deepEqual(violations, [], `${route} failed ${viewport} audit.`);
};

const setViewport = async (client, width, height, mobile) => {
  await client.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
    screenWidth: width,
    screenHeight: height,
  });
};

const captureScreenshot = async (client, filename) => {
  const screenshot = await client.call("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const path = join(artifactsDirectory, filename);
  await writeFile(path, Buffer.from(screenshot.data, "base64"));
  report.screenshots.push(path);
};

const pressKey = async (client, key, code, modifiers = 0) => {
  const virtualKeyCodes = {
    ArrowDown: 40,
    ArrowLeft: 37,
    ArrowRight: 39,
    ArrowUp: 38,
    Enter: 13,
    Escape: 27,
    Tab: 9,
  };
  const windowsVirtualKeyCode =
    key.length === 1
      ? key.toUpperCase().charCodeAt(0)
      : (virtualKeyCodes[key] ?? 0);
  await client.call("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
  await client.call("Input.dispatchKeyEvent", {
    type: "keyUp",
    key,
    code,
    modifiers,
    windowsVirtualKeyCode,
    nativeVirtualKeyCode: windowsVirtualKeyCode,
  });
};

await mkdir(artifactsDirectory, { recursive: true });
const downloadsDirectory = await mkdtemp(
  join(artifactsDirectory, "downloads-"),
);
let preview = null;
let edge = null;
let client = null;
let profileDirectory = null;
let executionPassed = false;

try {
  const build = spawn(process.execPath, [vite, "build"], {
    cwd: webRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const buildOutput = commandOutput(build);
  try {
    await waitForExit(build, "Production web build", BUILD_TIMEOUT_MS);
  } catch (error) {
    const buildError =
      error instanceof Error ? error : new Error(String(error));
    throw new Error(`${buildError.message}\n${buildOutput()}`, {
      cause: error,
    });
  }
  const prepare = spawn(process.execPath, [prepareSitesBuild], {
    cwd: webRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const prepareOutput = commandOutput(prepare);
  try {
    await waitForExit(
      prepare,
      "Production asset preparation",
      ASSET_PREPARATION_TIMEOUT_MS,
    );
  } catch (error) {
    const prepareError =
      error instanceof Error ? error : new Error(String(error));
    throw new Error(`${prepareError.message}\n${prepareOutput()}`, {
      cause: error,
    });
  }

  const previewPort = await reservePort();
  const origin = `http://127.0.0.1:${previewPort}`;
  report.origin = origin;
  preview = spawn(
    process.execPath,
    [
      vite,
      "preview",
      "--host",
      "127.0.0.1",
      "--port",
      String(previewPort),
      "--strictPort",
    ],
    {
      cwd: webRoot,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const previewOutput = commandOutput(preview);
  await waitForHttp(origin, preview, previewOutput);

  const edgePath = await findEdge();
  profileDirectory = await mkdtemp(join(tmpdir(), "systemforge-edge-"));
  edge = spawn(
    edgePath,
    [
      "--headless=new",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-features=Translate",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${profileDirectory}`,
      "about:blank",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    },
  );
  const edgeOutput = commandOutput(edge);
  const devToolsPort = await readDevToolsPort(
    profileDirectory,
    edge,
    edgeOutput,
  );
  const version = await fetch(`http://127.0.0.1:${devToolsPort}/json/version`, {
    signal: AbortSignal.timeout(5_000),
  }).then((response) => response.json());
  report.browser = {
    executable: edgePath,
    product: version.Browser,
    protocolVersion: version["Protocol-Version"],
  };

  const target = await openPage(devToolsPort, `${origin}/`);
  client = new CdpClient(target.webSocketDebuggerUrl);
  await client.connect();
  await Promise.all([
    client.call("Page.enable"),
    client.call("Runtime.enable"),
    client.call("Network.enable"),
    client.call("Log.enable"),
    client.call("Accessibility.enable"),
  ]);
  await client.call("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: downloadsDirectory,
    eventsEnabled: true,
  });
  await client.call("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });

  let offlineExpected = false;
  client.on("Runtime.consoleAPICalled", (event) => {
    if (!["error", "assert"].includes(event.type)) return;
    const message =
      event.args
        ?.map((argument) => argument.value ?? argument.description)
        .join(" ") ?? event.type;
    if (offlineExpected && message.includes("ERR_INTERNET_DISCONNECTED"))
      report.expectedOfflineConsoleErrors.push(message);
    else report.consoleErrors.push(message);
  });
  client.on("Runtime.exceptionThrown", (event) => {
    report.consoleErrors.push(
      event.exceptionDetails?.exception?.description ??
        event.exceptionDetails?.text ??
        "Uncaught browser exception",
    );
  });
  client.on("Log.entryAdded", (event) => {
    if (event.entry?.level !== "error") return;
    if (
      offlineExpected &&
      event.entry.text.includes("ERR_INTERNET_DISCONNECTED")
    )
      report.expectedOfflineConsoleErrors.push(event.entry.text);
    else report.consoleErrors.push(event.entry.text);
  });
  client.on("Network.loadingFailed", (event) => {
    if (event.canceled) return;
    const failure = `${event.errorText}${event.blockedReason ? ` (${event.blockedReason})` : ""}`;
    if (offlineExpected) report.expectedOfflineNetworkErrors.push(failure);
    else report.networkErrors.push(failure);
  });
  client.on("Network.responseReceived", (event) => {
    const status = event.response?.status ?? 0;
    if (status < 400) return;
    const url = event.response?.url ?? "unknown URL";
    let isAvailabilityProbe = false;
    try {
      isAvailabilityProbe = new URL(url).pathname.startsWith("/api/health/");
    } catch {
      // Retain malformed response URLs as errors.
    }
    if (!isAvailabilityProbe) report.networkErrors.push(`${status} ${url}`);
  });

  const routes = [
    ["/", "Build and test distributed systems"],
    ["/lab", "SYSTEM TOPOLOGY"],
    ["/custom", "Define the test"],
    ["/interview", "Prepare the interview"],
    ["/replay", "Verify and replay a run"],
    ["/acceptance-route-not-found", "No workspace at this address"],
  ];

  await setViewport(client, 1440, 900, false);
  for (const [route, readyText] of routes) {
    await navigate(client, `${origin}${route}`, readyText);
    await auditPage(client, route, "desktop-1440x900");
  }

  await navigate(client, `${origin}/lab`, "SYSTEM TOPOLOGY");
  await openDecisionWorkbench(client);
  await waitFor(
    client,
    'document.querySelector("[role=dialog]") !== null',
    "the keyboard-opened decision workbench",
  );
  for (let index = 0; index < 6; index += 1) {
    await pressKey(client, "Tab", "Tab");
    assert.equal(
      await evaluate(
        client,
        'document.querySelector("[role=dialog]")?.contains(document.activeElement) === true',
      ),
      true,
      "Decision-workbench focus escaped its modal dialog.",
    );
  }
  await pressKey(client, "Tab", "Tab", 8);
  assert.equal(
    await evaluate(
      client,
      'document.querySelector("[role=dialog]")?.contains(document.activeElement) === true',
    ),
    true,
    "Reverse focus navigation escaped the decision-workbench dialog.",
  );
  await pressKey(client, "Escape", "Escape");
  await waitFor(
    client,
    'document.querySelector("[role=dialog]") === null',
    "the keyboard-closed decision workbench",
  );
  await clickControl(client, "Open command palette");
  await waitFor(
    client,
    'document.querySelector(".command-palette[role=dialog]") !== null',
    "the keyboard-opened command palette",
  );
  await pressKey(client, "ArrowDown", "ArrowDown");
  await pressKey(client, "ArrowUp", "ArrowUp");
  await pressKey(client, "Escape", "Escape");
  await waitFor(
    client,
    'document.querySelector(".command-palette[role=dialog]") === null',
    "the keyboard-closed command palette",
  );
  const tabStops = [];
  for (let index = 0; index < 8; index += 1) {
    await pressKey(client, "Tab", "Tab");
    tabStops.push(
      await evaluate(
        client,
        `(() => {
          const active = document.activeElement;
          return active && active !== document.body && active !== document.documentElement
            ? (active.getAttribute("aria-label") || active.textContent || active.tagName).replace(/\\s+/g, " ").trim()
            : "";
        })()`,
      ),
    );
  }
  assert.equal(
    tabStops.every(Boolean),
    true,
    "Sequential Tab navigation reached the document body.",
  );
  assert.equal(
    new Set(tabStops).size >= 4,
    true,
    `Sequential Tab navigation exposed too few distinct controls: ${tabStops.join(" | ")}`,
  );
  report.interactions.push(
    "keyboard shortcut metadata, modal focus trap, palette arrows and sequential focus",
  );

  await navigate(client, `${origin}/custom`, "Define the test");
  await waitFor(
    client,
    'document.querySelector("[aria-label=\'AI drafting assistant\']")?.textContent?.includes("release-locked") === true',
    "the release-locked AI capability state",
  );
  assert.equal(
    await evaluate(
      client,
      `(() => {
        const panel = document.querySelector("[aria-label='AI drafting assistant']");
        const prepare = [...(panel?.querySelectorAll("button") || [])].find((button) => button.textContent?.includes("Prepare validated proposal"));
        return Boolean(
          panel
          && prepare?.disabled
          && panel.textContent?.includes("release-locked")
          && document.querySelector("input")
          && document.querySelector("textarea"),
        );
      })()`,
    ),
    true,
    "Capability-off AI state did not preserve and explain the manual workflow.",
  );
  const originalCustomLink = await readLabeledField(client, "Scenario link");
  const customTitle = "Edge acceptance checkout surge";
  await setLabeledField(client, "Scenario title", customTitle);
  await waitFor(
    client,
    labeledFieldExpression(
      "Scenario link",
      `return field.value !== ${JSON.stringify(originalCustomLink)} && field.value.includes("#share=");`,
    ),
    "the updated browser-local scenario link",
  );
  const customShareLink = await readLabeledField(client, "Scenario link");
  assert.match(customShareLink, /^http:\/\/127\.0\.0\.1:\d+\/lab#share=/);
  await clickControl(client, "Open in Lab");
  await waitFor(
    client,
    `document.body?.textContent.includes(${JSON.stringify(customTitle)})`,
    "the edited custom scenario in Lab",
  );
  await navigate(client, `${origin}/`, "Build and test distributed systems");
  await navigate(client, customShareLink, customTitle);
  assert.equal(
    await evaluate(
      client,
      `document.querySelector(".scenario-title")?.textContent?.includes(${JSON.stringify(customTitle)}) === true`,
    ),
    true,
    "The browser-local share did not restore the edited scenario.",
  );
  await clickControl(client, "Open command palette");
  await clickControlWithin(client, ".command-palette", "Save snapshot");
  await openDecisionWorkbench(client);
  await clickControlWithin(client, "[role=dialog]", "Versions");
  await waitFor(
    client,
    'document.querySelector(".snapshot-ledger")?.textContent?.includes("Manual snapshot") === true',
    "the saved browser-local topology snapshot",
  );
  await pressKey(client, "Escape", "Escape");
  report.interactions.push(
    "AI capability-off, custom edit, local share restore and saved snapshot",
  );

  const paused = await evaluate(
    client,
    `(async () => {
      const run = [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Run locally"));
      if (!run) return false;
      return new Promise((resolve) => {
        const deadline = performance.now() + 5000;
        const pauseWhenReady = () => {
          const pause = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim().endsWith("Pause"));
          if (pause && !pause.disabled) {
            pause.click();
            resolve(true);
            return;
          }
          if (performance.now() >= deadline) {
            resolve(false);
            return;
          }
          requestAnimationFrame(pauseWhenReady);
        };
        run.click();
        requestAnimationFrame(pauseWhenReady);
      });
    })()`,
    true,
  );
  assert.equal(paused, true, "The local run could not be paused in flight.");
  await waitFor(
    client,
    "document.querySelector(\"[aria-label='Paused run interventions']\") !== null",
    "paused run controls",
  );
  await clickControl(client, "Snapshot replay");
  await clickControl(client, "Capture fork");
  await waitFor(
    client,
    `(() => {
      const button = [...document.querySelectorAll("button")].find((control) => control.textContent?.includes("Open captured fork"));
      return Boolean(button && !button.disabled);
    })()`,
    "the modeled-time captured fork",
  );
  await clickControl(client, "Step one local-run batch");
  await clickControl(client, "Scale to");
  await waitFor(
    client,
    'document.querySelector(".run-intervention-panel__log") !== null',
    "the intervention evidence log",
  );
  assert.equal(
    await evaluate(
      client,
      `(() => {
        const select = document.querySelector("[aria-label='Local run playback speed']");
        if (!select) return false;
        select.value = "16";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    ),
    true,
    "The run speed control was unavailable.",
  );
  await clickControl(client, "Resume");
  await waitFor(
    client,
    'document.querySelector(".simulation-run-state")?.textContent?.includes("results ready")',
    "local run completion",
    30_000,
  );
  report.interactions.push(
    "run, pause, modeled-time snapshot/fork, step, intervention, resume and completion",
  );

  await clickControl(client, "investigate");
  await clickControl(client, "Traces");
  await waitFor(
    client,
    "document.querySelector(\"[aria-label='Play path']\") !== null",
    "sampled trace path controls",
  );
  const playableTrace = await evaluate(
    client,
    `(async () => {
      const select = document.querySelector("[aria-label='Request trace']");
      if (!select) return false;
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      for (const option of select.options) {
        setter?.call(select, option.value);
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const play = document.querySelector("[aria-label='Play path']");
        const next = document.querySelector("[aria-label='Next path step']");
        if (play && !play.disabled && next && !next.disabled) return true;
      }
      return false;
    })()`,
    true,
  );
  assert.equal(
    playableTrace,
    true,
    "No completed-run trace exposed a playable modeled span path.",
  );
  await clickControl(client, "Play path");
  await clickControl(client, "Next path step");
  await waitFor(
    client,
    "document.querySelector(\".system-edge--path, [aria-label^='Path playback']\") !== null",
    "topology path playback evidence",
  );
  assert.equal(
    await evaluate(
      client,
      'document.querySelector(".trace-playback__motion")?.textContent?.includes("Reduced motion") === true',
    ),
    true,
    "Reduced-motion trace playback did not expose its discrete-mode status.",
  );
  const motionAudit = await evaluate(
    client,
    `(() => [...document.querySelectorAll(".system-edge--path, .trace-playback__motion, .trace-playback__transport button")]
      .filter((element) => element.getClientRects().length)
      .map((element) => {
        const style = getComputedStyle(element);
        const seconds = (value) => value.split(",").map((part) => parseFloat(part) || 0);
        return {
          selector: element.className?.baseVal || element.className || element.tagName,
          animation: Math.max(...seconds(style.animationDuration)),
          transition: Math.max(...seconds(style.transitionDuration)),
        };
      }))()`,
  );
  assert.equal(
    motionAudit.every(
      ({ animation, transition }) => animation <= 0.01 && transition <= 0.01,
    ),
    true,
    `Reduced-motion mode retained animated behavior: ${JSON.stringify(motionAudit)}`,
  );
  report.interactions.push("sampled trace and reduced-motion path playback");
  await auditPage(client, "/lab?completed-flow", "desktop-1440x900");
  await captureScreenshot(client, "lab-completed-desktop.png");

  await openDecisionWorkbench(client);
  await clickControlWithin(client, "[role=dialog]", "Runs");
  await waitFor(
    client,
    `(() => {
      const panel = document.querySelector("#decision-panel-runs");
      return Boolean(
        panel?.textContent?.includes("Run library") &&
        panel?.textContent?.includes("Completed") &&
        panel?.textContent?.includes("Verify and replay"),
      );
    })()`,
    "the persisted local Run library record",
  );
  report.interactions.push(
    "automatic candidate-safe Run library persistence and replay availability",
  );
  await clickControlWithin(client, "[role=dialog]", "Report");
  await clickControlWithin(client, "[role=dialog]", "Portable replay bundle");
  const replayBundlePath = await waitForDownloadedJson(downloadsDirectory);
  const replayBundle = await readFile(replayBundlePath, "utf8");
  assert.doesNotThrow(() => JSON.parse(replayBundle));
  await clickControlWithin(
    client,
    "[role=dialog]",
    "Create and apply static fork",
  );
  await clickControlWithin(client, "[role=dialog]", "Versions");
  await waitFor(
    client,
    "document.querySelector(\"[aria-label='Current completed-run fork']\") !== null",
    "completed-run fork provenance",
  );
  await pressKey(client, "Escape", "Escape");

  await navigate(client, `${origin}/replay`, "Verify and replay a run");
  await injectJsonFile(client, 0, "accepted-replay.json", replayBundle);
  await waitFor(
    client,
    'document.body?.textContent.includes("Bundle checks passed for this model build")',
    "portable replay validation",
  );
  await injectJsonFile(client, 1, "comparison-replay.json", replayBundle);
  await waitFor(
    client,
    'document.querySelector(".replay-comparison__results")?.textContent?.includes("MATCH") === true',
    "replay input comparison",
  );
  await clickControl(client, "Run comparison");
  await waitFor(
    client,
    'document.querySelector(".replay-output") !== null',
    "synchronized replay output comparison",
    45_000,
  );
  await clickControl(client, "Verify and replay");
  await waitFor(
    client,
    'location.pathname === "/lab" && document.body?.textContent.includes("SYSTEM TOPOLOGY")',
    "the verified replay Lab route",
  );
  await waitFor(
    client,
    `(() => {
      const label = document.querySelector(".simulation-run-state")?.textContent?.trim();
      return Boolean(label && !["not run", "error"].includes(label));
    })()`,
    "the verified replay worker session",
  );
  const replayState = await evaluate(
    client,
    `(() => ({
      url: location.href,
      heading: document.querySelector("h1")?.textContent?.trim() || null,
      label: document.querySelector(".simulation-run-state")?.textContent?.trim() || null,
      speedAvailable: document.querySelector("[aria-label='Local run playback speed']") !== null,
      notice: document.querySelector("[role='status'], .service-banner")?.textContent?.replace(/\\s+/g, " ").trim() || null,
    }))()`,
  );
  report.replayState = replayState;
  if (["not run", "error"].includes(replayState.label)) {
    report.acceptanceDefects.push(
      `Verified replay reached Lab without an active replay session: ${JSON.stringify(replayState)}`,
    );
  } else {
    if (replayState.speedAvailable)
      await setLabeledField(client, "Local run playback speed", "16");
    await waitFor(
      client,
      'document.querySelector(".simulation-run-state")?.textContent?.includes("results ready")',
      "verified replay completion in Lab",
      60_000,
    );
  }
  report.interactions.push(
    "portable replay export, validation, synchronized comparison, replay and static fork provenance",
  );

  await navigate(client, `${origin}/interview`, "Prepare the interview");
  const privateSentinel = "PRIVATE EDGE ACCEPTANCE RUBRIC 74291";
  const hiddenSentinel = "Hidden overload recovery criterion 74291";
  await setLabeledField(client, "Evaluation brief", privateSentinel);
  await setLabeledField(client, "Requirement label", hiddenSentinel);
  await setLabeledField(client, "Visibility", "hidden");
  await waitFor(
    client,
    labeledFieldExpression(
      "Interviewer link",
      'return field.value.includes("#share=");',
    ),
    "the interviewer-local share link",
  );
  const interviewerLink = await readLabeledField(client, "Interviewer link");
  const candidateLink = await readLabeledField(client, "Candidate link");
  assert.notEqual(
    interviewerLink,
    candidateLink,
    "Interview role links unexpectedly shared the same payload.",
  );
  await navigate(client, interviewerLink, "SYSTEM TOPOLOGY");
  await waitFor(
    client,
    `document.body?.textContent.includes(${JSON.stringify(hiddenSentinel)}) && document.body?.textContent.toLowerCase().includes("interviewer")`,
    "the interviewer-only local criteria and role",
  );
  await navigate(client, `${origin}/`, "Build and test distributed systems");
  await navigate(client, candidateLink, "SYSTEM TOPOLOGY");
  await waitFor(
    client,
    'document.body?.textContent.includes("Candidate view") === true',
    "the candidate-safe interview view",
  );
  const candidatePrivacy = await evaluate(
    client,
    `(() => {
      const stored = Object.keys(localStorage).map((key) => localStorage.getItem(key) || "").join("\\n")
        + Object.keys(sessionStorage).map((key) => sessionStorage.getItem(key) || "").join("\\n");
      return {
        candidateView: document.body?.textContent.includes("Candidate view") === true,
        privateTextVisible: document.body?.textContent.includes(${JSON.stringify(privateSentinel)}) === true,
        hiddenCriterionVisible: document.body?.textContent.includes(${JSON.stringify(hiddenSentinel)}) === true,
        privateTextStored: stored.includes(${JSON.stringify(privateSentinel)}),
        hiddenCriterionStored: stored.includes(${JSON.stringify(hiddenSentinel)}),
        editingLinkVisible: [...document.querySelectorAll("a")].some((anchor) => anchor.textContent?.includes("Edit scenario")),
      };
    })()`,
  );
  assert.deepEqual(
    candidatePrivacy,
    {
      candidateView: true,
      privateTextVisible: false,
      hiddenCriterionVisible: false,
      privateTextStored: false,
      hiddenCriterionStored: false,
      editingLinkVisible: false,
    },
    "Candidate-local interview state crossed the interviewer privacy boundary.",
  );
  report.interactions.push(
    "interviewer/private local link and candidate-safe privacy boundary",
  );

  await setViewport(client, 390, 844, true);
  const mobileRoutes = [
    ["/", "RUNS IN THIS BROWSER"],
    ["/lab", "SYSTEM TOPOLOGY"],
    ["/custom", "OPTIONAL DRAFTING ASSISTANT"],
    ["/interview", "PRIVATE RUBRIC"],
    ["/replay", "CHOOSE A REPLAY BUNDLE"],
    ["/acceptance-route-not-found", "WORKSPACES"],
  ];
  for (const [route, readyText] of mobileRoutes) {
    await navigate(client, `${origin}${route}`, readyText);
    await auditPage(client, route, "mobile-390x844");
  }
  await navigate(client, `${origin}/lab`, "SYSTEM TOPOLOGY");
  await evaluate(
    client,
    `(() => {
      document.querySelector(".architecture-workspace")?.scrollIntoView({ block: "start" });
      return true;
    })()`,
  );
  await waitFor(
    client,
    'document.querySelectorAll(".architecture-workspace .react-flow__node").length >= 3',
    "the mobile topology nodes",
  );
  await clickControl(client, "Fit view");
  await delay(250);
  const mobileWorkspaceAudit = await evaluate(
    client,
    `(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const bounds = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0;
      };
      const flow = document.querySelector(".architecture-workspace .react-flow");
      const flowBounds = flow?.getBoundingClientRect();
      const nodes = [...document.querySelectorAll(".architecture-workspace .react-flow__node")]
        .filter(visible).map((element) => {
          const bounds = element.getBoundingClientRect();
          return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
        });
      const targets = [
        document.querySelector(".button--run"),
        document.querySelector(".react-flow__controls-fitview"),
        ...document.querySelectorAll(".workspace-modes button"),
      ].filter((element) => element && visible(element)).map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          name: element.getAttribute("aria-label") || element.textContent?.replace(/\\s+/g, " ").trim(),
          width: bounds.width,
          height: bounds.height,
        };
      });
      const operationalText = [
        ...document.querySelectorAll(".mobile-state-strip > *, .requirements-score strong, .react-flow__node strong, .react-flow__node small"),
      ].filter(visible).map((element) => ({
        text: element.textContent?.trim(),
        fontSize: parseFloat(getComputedStyle(element).fontSize),
      }));
      return {
        viewport: { width: innerWidth, height: innerHeight },
        flow: flowBounds && { left: flowBounds.left, right: flowBounds.right, top: flowBounds.top, bottom: flowBounds.bottom },
        nodes,
        targets,
        operationalText,
      };
    })()`,
  );
  assert.equal(mobileWorkspaceAudit.viewport.width, 390);
  assert.equal(
    mobileWorkspaceAudit.flow.left >= -1 &&
      mobileWorkspaceAudit.flow.right <=
        mobileWorkspaceAudit.viewport.width + 1,
    true,
    `The mobile topology canvas exceeded the viewport: ${JSON.stringify(mobileWorkspaceAudit.flow)}`,
  );
  assert.equal(
    mobileWorkspaceAudit.nodes.length >= 3 &&
      mobileWorkspaceAudit.nodes.every(
        (node) =>
          node.left >= mobileWorkspaceAudit.flow.left - 2 &&
          node.right <= mobileWorkspaceAudit.flow.right + 2 &&
          node.top >= mobileWorkspaceAudit.flow.top - 2 &&
          node.bottom <= mobileWorkspaceAudit.flow.bottom + 2,
      ),
    true,
    `Fit view did not keep the topology inside the mobile canvas: ${JSON.stringify(mobileWorkspaceAudit.nodes)}`,
  );
  assert.equal(
    mobileWorkspaceAudit.targets.length >= 5 &&
      mobileWorkspaceAudit.targets.every(
        ({ width, height }) => width >= 40 && height >= 40,
      ),
    true,
    `Mobile primary controls missed the 40px touch target: ${JSON.stringify(mobileWorkspaceAudit.targets)}`,
  );
  assert.equal(
    mobileWorkspaceAudit.operationalText.length >= 5 &&
      mobileWorkspaceAudit.operationalText.every(
        ({ fontSize }) => fontSize >= 12,
      ),
    true,
    `Mobile operational text fell below 12px: ${JSON.stringify(mobileWorkspaceAudit.operationalText)}`,
  );
  assert.equal(
    await evaluate(
      client,
      `(async () => {
        const runMode = [...document.querySelectorAll(".workspace-modes button")].find((button) => button.textContent?.trim().endsWith("run"));
        runMode?.click();
        const run = document.querySelector(".button--run");
        if (!runMode || !run) return false;
        run.click();
        return new Promise((resolve) => {
          const deadline = performance.now() + 5000;
          const pauseWhenReady = () => {
            const primary = document.querySelector(".button--run");
            if (primary?.textContent?.trim().endsWith("Pause") && !primary.disabled) {
              primary.click();
              resolve(true);
              return;
            }
            if (performance.now() >= deadline) {
              resolve(false);
              return;
            }
            requestAnimationFrame(pauseWhenReady);
          };
          requestAnimationFrame(pauseWhenReady);
        });
      })()`,
      true,
    ),
    true,
    "Mobile run-mode or primary run control could not start and pause a run.",
  );
  await waitFor(
    client,
    'document.querySelector(".button--run")?.textContent?.trim().endsWith("Resume") === true',
    "the paused mobile local run",
  );
  await clickControl(client, "Cancel local run");
  report.interactions.push(
    "390x844 topology fit, computed bounds/font/touch gates and primary run controls",
  );
  await captureScreenshot(client, "lab-mobile-390.png");

  const offlineRoutes = [
    ["/lab", "SYSTEM TOPOLOGY"],
    ["/custom", "OPTIONAL DRAFTING ASSISTANT"],
    ["/interview", "PRIVATE RUBRIC"],
    ["/replay", "CHOOSE A REPLAY BUNDLE"],
  ];
  for (const [route, readyText] of offlineRoutes)
    await navigate(client, `${origin}${route}`, readyText);
  await evaluate(
    client,
    "navigator.serviceWorker.ready.then((registration) => Boolean(registration.active))",
    true,
  );
  await client.call("Page.reload", { ignoreCache: false });
  await waitFor(
    client,
    'document.body?.innerText.toLowerCase().includes("choose a replay bundle")',
    "the service-worker-controlled warm replay route",
  );
  offlineExpected = true;
  await client.call("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  await client.call("Network.overrideNetworkState", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: "none",
  });
  for (const [route, readyText] of offlineRoutes) {
    await navigate(client, `${origin}${route}`, readyText);
    await auditPage(client, `${route}?offline`, "mobile-390x844");
  }
  const offlineState = await evaluate(
    client,
    `(async () => {
      try {
        const response = await fetch("/api/browser-offline-probe?nonce=" + crypto.randomUUID(), { cache: "no-store" });
        return { navigatorOnLine: navigator.onLine, networkProbeRejected: false, status: response.status };
      } catch (error) {
        return {
          navigatorOnLine: navigator.onLine,
          networkProbeRejected: true,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    true,
  );
  report.offlineState = offlineState;
  assert.equal(
    offlineState.networkProbeRejected,
    true,
    `The offline transport probe unexpectedly reached the API: ${JSON.stringify(offlineState)}`,
  );
  await captureScreenshot(client, "replay-warm-offline-390.png");
  report.interactions.push("warm service-worker offline lazy-route navigation");
  offlineExpected = false;
  await client.call("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "wifi",
  });
  await client.call("Network.overrideNetworkState", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: "wifi",
  });

  const uniqueConsoleErrors = [...new Set(report.consoleErrors)];
  const uniqueNetworkErrors = [...new Set(report.networkErrors)];
  report.consoleErrors = uniqueConsoleErrors;
  report.networkErrors = uniqueNetworkErrors;
  assert.deepEqual(
    uniqueConsoleErrors,
    [],
    "Browser console errors were recorded.",
  );
  assert.deepEqual(
    uniqueNetworkErrors,
    [],
    "Unexpected network errors were recorded.",
  );
  assert.deepEqual(
    report.acceptanceDefects,
    [],
    "Browser acceptance found product workflow defects.",
  );
  executionPassed = true;
} catch (error) {
  report.error =
    error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(report.error);
  process.exitCode = 1;
} finally {
  const cleanupErrors = [];
  try {
    if (client) client.close();
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await terminateProcessTree(edge, "Microsoft Edge");
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  try {
    await terminateProcessTree(preview, "Vite preview");
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error.message : String(error));
  }
  if (profileDirectory) {
    try {
      await rm(profileDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  if (cleanupErrors.length) {
    report.cleanupError = cleanupErrors.join("; ");
    process.exitCode = 1;
  }
  report.result =
    executionPassed && cleanupErrors.length === 0 ? "passed" : "failed";
  report.finishedAt = new Date().toISOString();
  await writeFile(
    join(artifactsDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (report.result === "passed")
    console.log(
      `Browser acceptance passed in ${report.browser.product}: ${report.routes.length} route audits, ${report.interactions.length} interaction groups.`,
    );
  console.log(
    `Browser artifacts: ${join(artifactsDirectory, basename("report.json"))}`,
  );
}
