#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const stateDir = process.env.TAILNET_PREVIEW_STATE_DIR || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "tailnet-preview");
const registryPath = join(stateDir, "registry.json");
const lockDir = join(stateDir, ".registry-lock");
const gatewayLabel = process.env.TAILNET_PREVIEW_GATEWAY_LABEL || "com.codex.tailnet-preview.gateway";
const gatewayLocalCandidates = portsFrom(process.env.TAILNET_PREVIEW_GATEWAY_LOCAL_PORTS || "4310-4399");
const gatewayHttpsCandidates = portsFrom(process.env.TAILNET_PREVIEW_GATEWAY_HTTPS_PORTS || "443,9443-9499");
const appHttpsCandidates = portsFrom(process.env.TAILNET_PREVIEW_APP_HTTPS_PORTS || "8443-8499");
const devPortCandidates = portsFrom(process.env.TAILNET_PREVIEW_DEV_PORTS || "3000-3999,4173-4299,5000-5099");
const tailscaleBin = process.env.TAILNET_PREVIEW_TAILSCALE_BIN || executable("tailscale", ["/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale"]);
const launchctlBin = process.env.TAILNET_PREVIEW_LAUNCHCTL_BIN || executable("launchctl", ["/bin/launchctl"]);
const systemctlBin = process.env.TAILNET_PREVIEW_SYSTEMCTL_BIN || executable("systemctl", ["/usr/bin/systemctl", "/bin/systemctl"]);
const systemdRunBin = process.env.TAILNET_PREVIEW_SYSTEMD_RUN_BIN || executable("systemd-run", ["/usr/bin/systemd-run", "/bin/systemd-run"]);
const jsonOutput = process.argv.includes("--json");

function usage() {
  process.stdout.write(`Tailnet Preview — durable private development previews

Usage:
  preview ensure [--id=ID] [--name=NAME] [--route=/path] [--view=name=/path] [--cwd=DIR] [--port=N] -- <argv...>
  preview attach <port> [--id=ID] [--name=NAME] [--route=/path] [--view=name=/path] [--cwd=DIR]
  preview inspect [id] [--verify]
  preview list
  preview restart <id>
  preview sleep <id>
  preview resume <id>
  preview remove <id>
  preview reload-gateway
  preview doctor

`);
}

class PreviewError extends Error {
  constructor(message, code = "failure", details = {}) { super(message); this.code = code; this.details = details; }
}
function fail(message, code = "failure", details = {}) { throw new PreviewError(message, code, details); }
function reportFailure(error) {
  const code = error instanceof PreviewError ? error.code : "unexpected_error";
  const details = error instanceof PreviewError ? error.details : {};
  if (jsonOutput) process.stderr.write(`${JSON.stringify({ ok: false, code, message: error.message || String(error), ...details })}\n`);
  else {
    process.stderr.write(`Tailnet Preview: ${error.message || String(error)}\n`);
    if (details.log) process.stderr.write(`Log: ${details.log}\n`);
    if (details.correctiveAction) process.stderr.write(`Next: ${details.correctiveAction}\n`);
  }
  process.exitCode = 1;
}

function emit(value, human) {
  process.stdout.write(jsonOutput ? `${JSON.stringify(value, null, 2)}\n` : human);
}

function executable(name, fallbacks = []) {
  const candidates = [...(process.env.PATH || "").split(":").filter(Boolean).map(directory => join(directory, name)), ...fallbacks];
  return candidates.find(candidate => existsSync(candidate)) || "";
}

function run(binary, args, { allowFailure = false } = {}) {
  if (!binary) return allowFailure ? { ok: false, stdout: "", stderr: "executable not found" } : fail(`${basename(args[0] || "required executable")} was not found.`, "missing_tool");
  try {
    const stdout = execFileSync(binary, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "";
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const result = { ok: false, stdout: String(error.stdout || ""), stderr: String(error.stderr || error.message || "") };
    if (allowFailure) return result;
    if (/Failed to load preferences/i.test(result.stderr)) fail("Tailscale cannot read preferences inside the current sandbox. Retry this helper with narrow approved execution authority.", "tailscale_sandbox");
    fail(result.stderr.trim() || `${basename(binary)} failed.`, "command_failed");
  }
}

function portsFrom(spec) {
  const values = [];
  for (const part of spec.split(",").map(value => value.trim()).filter(Boolean)) {
    if (/^\d+$/.test(part)) values.push(Number(part));
    else {
      const match = part.match(/^(\d+)-(\d+)$/);
      if (!match) throw new Error(`invalid port specification: ${part}`);
      for (let port = Number(match[1]); port <= Number(match[2]); port += 1) values.push(port);
    }
  }
  return [...new Set(values)].filter(validPort);
}

function validPort(port) { return Number.isInteger(port) && port > 0 && port < 65536; }
function parsePort(value, label = "port") { const port = Number(value); if (!validPort(port)) fail(`${label} must be between 1 and 65535.`, "invalid_argument"); return port; }
function sleep(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }
function slug(value) { return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63) || "preview"; }
function validId(value) { return /^[a-z0-9](?:[a-z0-9-]{0,62})$/.test(value); }
function routeValue(value = "/") {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) fail("route must be an application path, not a URL.", "invalid_route");
  return value.startsWith("/") ? value : `/${value}`;
}

function readJson(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function freshRegistry() { return { version: 3, gateway: null, projects: {} }; }
function registry() {
  if (!existsSync(registryPath)) return freshRegistry();
  const value = readJson(registryPath);
  if (value?.version === 3 && value.projects) return value;
  fail("registry is unreadable or uses an unsupported version; refusing to replace it.", "invalid_registry");
}

function writeRegistry(value) { writeJson(registryPath, { version: 3, gateway: value.gateway || null, projects: value.projects || {} }); }

async function withDirectoryLock(directory, busyMessage, operation) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      mkdirSync(directory);
      writeFileSync(join(directory, "owner.json"), JSON.stringify({ pid: process.pid, at: Date.now() }), { mode: 0o600 });
      try { return await operation(); }
      finally { try { unlinkSync(join(directory, "owner.json")); } catch {} try { rmdirSync(directory); } catch {} }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readJson(join(directory, "owner.json"));
      let alive = true;
      if (owner?.pid) { try { process.kill(owner.pid, 0); } catch { alive = false; } }
      const age = Date.now() - (owner?.at || statSync(directory).mtimeMs);
      if (!alive && age > 5000) { try { unlinkSync(join(directory, "owner.json")); } catch {} try { rmdirSync(directory); } catch {} }
      else await sleep(75);
    }
  }
  fail(busyMessage, "operation_busy");
}
function withLock(operation) { return withDirectoryLock(lockDir, "preview registry stayed busy for 30 seconds.", operation); }
function withOperationLock(name, operation) { return withDirectoryLock(join(stateDir, `.operation-${name}`), `${name} operation stayed busy for 30 seconds.`, operation); }

function requireTailscale() { if (!tailscaleBin) fail("tailscale was not found in PATH.", "missing_tailscale"); }
function tailscaleStatus() {
  requireTailscale();
  const result = run(tailscaleBin, ["status", "--json"], { allowFailure: true });
  if (!result.ok && /Failed to load preferences/i.test(result.stderr)) fail("Tailscale cannot read preferences inside the current sandbox. Retry this helper with narrow approved execution authority.", "tailscale_sandbox");
  if (!result.ok) fail(result.stderr.trim() || "could not read Tailscale status.", "tailscale_status");
  try { return JSON.parse(result.stdout); } catch { fail("Tailscale status did not return JSON.", "tailscale_status"); }
}
function dnsName() {
  const name = tailscaleStatus()?.Self?.DNSName;
  if (!name) fail("Tailscale is offline or has no MagicDNS name.", "tailscale_offline");
  return name.replace(/\.$/, "");
}
function serveStatus() {
  const result = run(tailscaleBin, ["serve", "status", "--json"], { allowFailure: true });
  if (!result.ok && /Failed to load preferences/i.test(result.stderr)) fail("Tailscale cannot read preferences inside the current sandbox. Retry this helper with narrow approved execution authority.", "tailscale_sandbox");
  if (!result.stdout.trim() || /No serve config/i.test(result.stdout)) return { TCP: {}, Web: {} };
  try { return JSON.parse(result.stdout); } catch { fail("Tailscale Serve status did not return JSON.", "serve_status"); }
}
function occupiedHttps(status) { return new Set(Object.keys(status?.TCP || {}).filter(port => status.TCP[port]?.HTTPS).map(Number)); }
function proxyTarget(status, dns, port) { return status?.Web?.[`${dns}:${port}`]?.Handlers?.["/"]?.Proxy || ""; }
function serveOn(httpsPort, localPort) { run(tailscaleBin, ["serve", "--bg", `--https=${httpsPort}`, `127.0.0.1:${localPort}`]); }
function serveOff(httpsPort) { run(tailscaleBin, ["serve", `--https=${httpsPort}`, "off"], { allowFailure: true }); }

function portOpen(port, timeout = 700) {
  return new Promise(resolvePromise => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = value => { socket.destroy(); resolvePromise(value); };
    socket.setTimeout(timeout, () => finish(false)); socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));
  });
}
function portAvailable(port) {
  return new Promise(resolvePromise => {
    const server = net.createServer(); server.unref(); server.once("error", () => resolvePromise(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePromise(true)));
  });
}
async function firstAvailable(candidates, reserved = new Set()) { for (const port of candidates) if (!reserved.has(port) && await portAvailable(port)) return port; return null; }

function httpCheck(port, route, { host = "127.0.0.1", timeout = 1800 } = {}) {
  return new Promise(resolvePromise => {
    const request = http.request({ hostname: "127.0.0.1", port, path: route, headers: { Host: host }, timeout }, response => {
      let body = ""; response.setEncoding("utf8"); response.on("data", chunk => { if (body.length < 8192) body += chunk; });
      response.on("end", () => resolvePromise({ ok: Boolean(response.statusCode && response.statusCode < 500 && response.statusCode !== 404), status: response.statusCode, body }));
    });
    request.on("timeout", () => request.destroy(new Error("timeout"))); request.on("error", error => resolvePromise({ ok: false, error: error.message })); request.end();
  });
}
function httpsCheck(dns, port, route, timeout = 7000) {
  if (process.env.TAILNET_PREVIEW_SKIP_REMOTE_VERIFY === "1") return Promise.resolve({ ok: true, skipped: true });
  return new Promise(resolvePromise => {
    const request = https.get({ hostname: dns, port, path: route, timeout }, response => {
      response.resume(); response.on("end", () => resolvePromise({ ok: Boolean(response.statusCode && response.statusCode < 500 && response.statusCode !== 404), status: response.statusCode }));
    });
    request.on("timeout", () => request.destroy(new Error("timeout"))); request.on("error", error => resolvePromise({ ok: false, error: error.message }));
  });
}

function supervisor() {
  if (platform() === "darwin" && launchctlBin) return "launchd";
  if (platform() === "linux" && systemctlBin && systemdRunBin) return "systemd";
  return "none";
}
function appLabel(id) { return platform() === "darwin" ? `com.codex.tailnet-preview.app.${id}` : `tailnet-preview-${id}`; }
function serviceRunning(label) {
  if (platform() === "darwin") return run(launchctlBin, ["print", `gui/${process.getuid()}/${label}`], { allowFailure: true }).ok;
  if (platform() === "linux") return run(systemctlBin, ["--user", "is-active", "--quiet", label], { allowFailure: true }).ok;
  return false;
}
function stopService(label) {
  if (platform() === "darwin") run(launchctlBin, ["remove", label], { allowFailure: true });
  else if (platform() === "linux") run(systemctlBin, ["--user", "stop", label], { allowFailure: true });
}
function startService(label, executablePath, argv, logPath = "") {
  stopService(label);
  if (platform() === "darwin") {
    if (logPath) mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    run(launchctlBin, ["submit", "-l", label, "-o", logPath, "-e", logPath, "--", executablePath, ...argv]);
  } else if (platform() === "linux") {
    run(systemdRunBin, ["--user", `--unit=${label}`, "--collect", executablePath, ...argv]);
  } else fail("supervised previews currently require macOS launchd or Linux systemd; use attach on this platform.", "unsupported_supervisor");
}

async function gatewayHealth(port) {
  const result = await httpCheck(port, "/_tailnet-preview/health", { timeout: 1000 });
  if (!result.ok) return null;
  try { return JSON.parse(result.body); } catch { return null; }
}
async function startGateway(current) {
  const gateway = current.gateway;
  for (let attempt = 0; attempt < 50 && await portOpen(gateway.localPort) && !(await gatewayHealth(gateway.localPort))?.ok; attempt += 1) await sleep(100);
  if (await portOpen(gateway.localPort) && !(await gatewayHealth(gateway.localPort))?.ok) fail(`gateway port ${gateway.localPort} is occupied by another process.`, "gateway_collision");
  startService(gateway.label, process.execPath, [join(scriptDir, "gateway-server.mjs"), "--host", "127.0.0.1", "--port", String(gateway.localPort), "--state-dir", stateDir], join(stateDir, "gateway.log"));
  for (let attempt = 0; attempt < 80; attempt += 1) { const health = await gatewayHealth(gateway.localPort); if (health?.version === 3) return; await sleep(100); }
  fail("gateway did not become healthy.", "gateway_start", { log: readJson(join(stateDir, "gateway.log")) || undefined });
}
async function ensureGateway(current, dns, status) {
  if (!current.gateway) {
    await withLock(async () => {
      const latest = registry();
      if (!latest.gateway) {
        const localPort = await firstAvailable(gatewayLocalCandidates);
        const occupied = occupiedHttps(status);
        const httpsPort = gatewayHttpsCandidates.find(port => !occupied.has(port));
        if (!localPort || !httpsPort) fail("no free gateway port is available.", "port_exhausted");
        latest.gateway = { localPort, httpsPort, label: gatewayLabel };
        writeRegistry(latest);
      }
    });
    current = registry();
  }
  const health = await gatewayHealth(current.gateway.localPort);
  if (!serviceRunning(current.gateway.label) || health?.version !== 3) {
    await withOperationLock("gateway", async () => {
      const latest = registry();
      const latestHealth = await gatewayHealth(latest.gateway.localPort);
      if (!serviceRunning(latest.gateway.label) || latestHealth?.version !== 3) await startGateway(latest);
    });
  }
  const actual = proxyTarget(serveStatus(), dns, current.gateway.httpsPort);
  const expected = `http://127.0.0.1:${current.gateway.localPort}`;
  if (actual && actual !== expected) fail(`gateway HTTPS port ${current.gateway.httpsPort} belongs to ${actual}.`, "serve_collision");
  if (!actual) serveOn(current.gateway.httpsPort, current.gateway.localPort);
}

function parseOptions(args) {
  const separator = args.indexOf("--");
  const optionArgs = separator >= 0 ? args.slice(0, separator) : args;
  const command = separator >= 0 ? args.slice(separator + 1) : [];
  const options = { views: {}, positional: [] };
  for (const arg of optionArgs.filter(value => value !== "--json")) {
    if (arg.startsWith("--id=")) options.id = arg.slice(5);
    else if (arg.startsWith("--name=")) options.name = arg.slice(7);
    else if (arg.startsWith("--route=")) options.route = routeValue(arg.slice(8));
    else if (arg.startsWith("--cwd=")) options.cwd = arg.slice(6);
    else if (arg.startsWith("--port=")) options.port = parsePort(arg.slice(7), "local port");
    else if (arg.startsWith("--view=")) {
      const match = arg.slice(7).match(/^([a-z0-9][a-z0-9-]{0,62})=(.+)$/);
      if (!match) fail("views use --view=name=/path.", "invalid_view");
      options.views[match[1]] = routeValue(match[2]);
    } else if (arg === "--verify") options.verify = true;
    else if (arg === "--force-restart") options.forceRestart = true;
    else if (arg.startsWith("--")) fail(`unknown option ${arg}.`, "invalid_argument");
    else options.positional.push(arg);
  }
  return { options, command };
}

function projectRoot(value = process.cwd()) {
  const resolved = resolve(value);
  try { return realpathSync(resolved); } catch { fail(`project directory does not exist: ${resolved}`, "invalid_cwd"); }
}
function projectConfig(root) {
  const value = readJson(join(root, ".tailnet-preview.json"));
  if (!value) return {};
  if (value.command && (!Array.isArray(value.command) || value.command.some(item => typeof item !== "string"))) fail(".tailnet-preview.json command must be an argv array.", "invalid_config");
  return value;
}
function packageKind(root) {
  const value = readJson(join(root, "package.json"));
  const dev = value?.scripts?.dev || "";
  if (/\bvite\b/.test(dev)) return "vite";
  if (/\bnext(?:\s|$)/.test(dev)) return "next";
  return "generic";
}
function preparedCommand(template, port, root) {
  const hadPlaceholder = template.some(arg => arg.includes("{port}"));
  const argv = template.map(arg => arg.replaceAll("{port}", String(port)));
  if (!argv.length) fail("ensure requires a command after -- or in .tailnet-preview.json.", "missing_command");
  if (!hadPlaceholder) {
    const kind = packageKind(root);
    const packageRun = ["npm", "pnpm", "yarn", "bun"].includes(basename(argv[0])) && argv.includes("dev");
    if (packageRun && kind === "vite") argv.push("--", "--host", "127.0.0.1", "--port", String(port), "--strictPort");
    else if (packageRun && kind === "next") argv.push("--", "--hostname", "127.0.0.1", "--port", String(port));
  }
  return argv;
}
function launchRecord(id) { return readJson(join(stateDir, "launch", `${id}.json`)); }
function writeLaunch(id, value) { writeJson(join(stateDir, "launch", `${id}.json`), value); }
function ownedTargets(current, project) {
  if (!project) return new Set();
  const targets = new Set([`http://127.0.0.1:${project.localPort}`]);
  if (project.transport === "gateway" && current.gateway?.localPort) targets.add(`http://127.0.0.1:${current.gateway.localPort}`);
  const priorPort = Number(launchRecord(project.id)?.env?.PORT);
  if (validPort(priorPort)) targets.add(`http://127.0.0.1:${priorPort}`);
  return targets;
}

async function waitForRoute(project, timeoutMs = Number(process.env.TAILNET_PREVIEW_START_TIMEOUT_MS || 20000)) {
  const deadline = Date.now() + timeoutMs;
  const route = project.views[project.primaryView];
  while (Date.now() < deadline) { const result = await httpCheck(project.localPort, route); if (result.ok) return result; await sleep(200); }
  return { ok: false, error: `route ${route} did not become healthy` };
}
async function startApp(project, forceRestart = false) {
  if (supervisor() === "none") fail("no supported user-level process supervisor was found; use attach.", "unsupported_supervisor");
  const label = project.launch.label;
  if (!forceRestart && serviceRunning(label) && (await httpCheck(project.localPort, project.views[project.primaryView])).ok) return;
  stopService(label);
  for (let attempt = 0; attempt < 30 && await portOpen(project.localPort); attempt += 1) await sleep(100);
  if (await portOpen(project.localPort)) fail(`local port ${project.localPort} is occupied by a process not owned by this preview.`, "local_port_collision");
  startService(label, process.execPath, [join(scriptDir, "app-runner.mjs"), "--state-dir", stateDir, "--id", project.id], join(stateDir, "logs", `${project.id}.log`));
  const result = await waitForRoute(project);
  if (!result.ok) {
    stopService(label);
    fail(`${project.name} did not become healthy on 127.0.0.1:${project.localPort}${project.views[project.primaryView]}.`, "app_start_failed", {
      log: join(stateDir, "logs", `${project.id}.log`),
      correctiveAction: "Inspect the supervisor log, correct only the launch command or missing executable, then rerun ensure once with the same preview ID.",
    });
  }
}

function urls(dns, current, project, view = project.primaryView) {
  const route = project.views[view];
  const base = `https://${dns}${current.gateway.httpsPort === 443 ? "" : `:${current.gateway.httpsPort}`}`;
  return { dashboard: base, viewer: `${base}/p/${encodeURIComponent(project.id)}/${encodeURIComponent(view)}`, direct: `https://${dns}:${project.httpsPort}${route}`, local: `http://127.0.0.1:${project.localPort}${route}` };
}
function receiptText(receipt) {
  return `Tailnet Preview is healthy.\nDashboard: ${receipt.urls.dashboard}\nViewer:    ${receipt.urls.viewer}\nDirect:    ${receipt.urls.direct}\nID:        ${receipt.id}\nMode:      ${receipt.mode}\nState:     ${receipt.state}\n`;
}

async function ensureCommand(args, existingOnlyId = "") {
  const { options, command } = parseOptions(args);
  const root = projectRoot(options.cwd);
  const config = projectConfig(root);
  const currentBefore = registry();
  const existingByRoot = Object.values(currentBefore.projects).find(project => project.root === root);
  if (!existingOnlyId && options.id && existingByRoot && existingByRoot.id !== options.id) fail(`project root is already registered as ${existingByRoot.id}.`, "identity_collision");
  const existing = existingOnlyId ? currentBefore.projects[existingOnlyId] : options.id ? currentBefore.projects[options.id] : existingByRoot;
  const id = existing?.id || options.id || config.id || slug(options.name || config.name || basename(root));
  if (!validId(id)) fail("preview id must use lowercase letters, digits, and hyphens.", "invalid_id");
  if (existing?.root && existing.root !== root) fail(`preview id ${id} belongs to a different project root.`, "identity_collision");
  const name = options.name || config.name || existing?.name || basename(root);
  const primaryRoute = routeValue(options.route || config.route || existing?.views?.[existing.primaryView] || "/");
  const views = { ...(config.views || {}), ...(existing?.views || {}), ...(options.views || {}) };
  for (const [view, route] of Object.entries(views)) { if (!validId(view)) fail(`invalid view name ${view}.`, "invalid_view"); views[view] = routeValue(route); }
  if (!Object.keys(views).length) views.default = primaryRoute;
  let primaryView = Object.entries(views).find(([, route]) => route === primaryRoute)?.[0];
  if (!primaryView) { primaryView = "default"; views[primaryView] = primaryRoute; }
  const template = command.length ? command : config.command || existing?.launch?.template || launchRecord(id)?.template || [];
  const status = serveStatus();
  let project;
  await withLock(async () => {
    const current = registry();
    const reservedLocal = new Set(Object.values(current.projects).filter(item => item.id !== id).map(item => item.localPort));
    const reservedHttps = new Set(Object.values(current.projects).filter(item => item.id !== id).map(item => item.httpsPort));
    const localPort = existing?.localPort || options.port || await firstAvailable(devPortCandidates, reservedLocal);
    const occupied = occupiedHttps(status);
    const httpsPort = existing?.httpsPort || appHttpsCandidates.find(port => !occupied.has(port) && !reservedHttps.has(port));
    if (!localPort || !httpsPort) fail("no free preview port is available.", "port_exhausted");
    const argv = preparedCommand(template, localPort, root);
    const now = new Date().toISOString();
    project = {
      id, name, root, mode: "supervised", state: "starting", localPort, httpsPort, transport: "gateway",
      primaryView, views, createdAt: existing?.createdAt || now, updatedAt: now,
      launch: { label: appLabel(id), template, commandFingerprint: argv.map(value => basename(value)).join(" ") },
    };
    current.projects[id] = project;
    writeRegistry(current);
    writeLaunch(id, {
      cwd: root,
      argv,
      env: {
        HOME: process.env.HOME || homedir(),
        // Browser resume/restart inherits launchd's minimal PATH. Keep the app's saved toolchain path.
        PATH: (existingOnlyId ? launchRecord(id)?.env?.PATH : null) || process.env.PATH || dirname(process.execPath),
        HOST: "127.0.0.1",
        PORT: String(localPort),
        NODE_ENV: "development",
      },
      template,
    });
  });

  const dns = dnsName();
  try {
    await withOperationLock(`project-${project.id}`, () => startApp(project, options.forceRestart));
    let current = registry();
    await ensureGateway(current, dns, status);
    current = registry();
    const actual = proxyTarget(serveStatus(), dns, project.httpsPort);
    const expected = `http://127.0.0.1:${current.gateway.localPort}`;
    if (actual && actual !== expected) fail(`Tailnet port ${project.httpsPort} belongs to ${actual}.`, "serve_collision");
    if (actual !== expected) serveOn(project.httpsPort, current.gateway.localPort);
    const remote = await httpsCheck(dns, project.httpsPort, project.views[project.primaryView]);
    if (!remote.ok) fail(`direct Tailnet route verification failed${remote.status ? ` with HTTP ${remote.status}` : `: ${remote.error}`}.`, "remote_unhealthy");
    await withLock(async () => { const latest = registry(); latest.projects[id] = { ...latest.projects[id], state: "healthy", updatedAt: new Date().toISOString(), lastVerifiedAt: new Date().toISOString() }; writeRegistry(latest); project = latest.projects[id]; });
    const latest = registry(); const receipt = { ok: true, id, mode: project.mode, state: project.state, views: project.views, urls: urls(dns, latest, project) };
    emit(receipt, receiptText(receipt));
  } catch (error) {
    await withLock(async () => { const latest = registry(); if (latest.projects[id]) { latest.projects[id].state = "failed"; latest.projects[id].updatedAt = new Date().toISOString(); writeRegistry(latest); } });
    throw error;
  }
}

async function attachCommand(args) {
  const { options } = parseOptions(args);
  const positional = [...options.positional];
  const localPort = parsePort(positional.shift(), "local app port");
  const root = projectRoot(options.cwd);
  const config = projectConfig(root);
  const currentBefore = registry();
  const existingByRoot = Object.values(currentBefore.projects).find(project => project.root === root);
  const id = options.id || config.id || existingByRoot?.id || slug(options.name || config.name || basename(root));
  if (!validId(id)) fail("preview id must use lowercase letters, digits, and hyphens.", "invalid_id");
  const name = options.name || config.name || existingByRoot?.name || basename(root);
  const route = routeValue(options.route || config.route || "/");
  const local = await httpCheck(localPort, route);
  if (!local.ok) fail(`intended route ${route} is not healthy on 127.0.0.1:${localPort}.`, "local_unhealthy");
  const status = serveStatus();
  const priorTargets = ownedTargets(currentBefore, currentBefore.projects[id]);
  let project;
  await withLock(async () => {
    const current = registry(); const existing = current.projects[id];
    if (existing?.root && existing.root !== root) fail(`preview id ${id} belongs to a different project root.`, "identity_collision");
    const reserved = new Set(Object.values(current.projects).filter(item => item.id !== id).map(item => item.httpsPort));
    const occupied = occupiedHttps(status);
    const httpsPort = existing?.httpsPort || appHttpsCandidates.find(port => !occupied.has(port) && !reserved.has(port));
    if (!httpsPort) fail("no free Tailnet preview port is available.", "port_exhausted");
    const views = { default: route, ...(config.views || {}), ...(options.views || {}) };
    project = { id, name, root, mode: "attached", state: "starting", localPort, httpsPort, transport: "gateway", primaryView: "default", views, createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
    current.projects[id] = project; writeRegistry(current);
  });
  const dns = dnsName(); let current = registry(); await ensureGateway(current, dns, status); current = registry();
  const actual = proxyTarget(serveStatus(), dns, project.httpsPort); const expected = `http://127.0.0.1:${current.gateway.localPort}`;
  if (actual && actual !== expected && actual !== `http://127.0.0.1:${localPort}` && !priorTargets.has(actual)) fail(`Tailnet port ${project.httpsPort} belongs to ${actual}.`, "serve_collision");
  if (actual !== expected) serveOn(project.httpsPort, current.gateway.localPort);
  const remote = await httpsCheck(dns, project.httpsPort, route); if (!remote.ok) fail("direct Tailnet route verification failed.", "remote_unhealthy");
  await withLock(async () => { const latest = registry(); latest.projects[id].state = "healthy"; latest.projects[id].lastVerifiedAt = new Date().toISOString(); writeRegistry(latest); project = latest.projects[id]; });
  const latest = registry(); const receipt = { ok: true, id, mode: "attached", state: "healthy", warning: "external process must remain running", views: project.views, urls: urls(dns, latest, project) };
  emit(receipt, `${receiptText(receipt)}Note:      attached; external process must remain running.\n`);
}

async function healthFor(dns, current, project, verify) {
  const route = project.views[project.primaryView]; const local = await httpCheck(project.localPort, route);
  const direct = verify && project.state !== "sleeping" ? await httpsCheck(dns, project.httpsPort, route) : null;
  const gateway = current.gateway ? await gatewayHealth(current.gateway.localPort) : null;
  return { localRoute: local.ok, directTailnet: direct?.ok ?? null, gateway: gateway?.version === 3, service: project.mode === "supervised" ? serviceRunning(project.launch?.label || appLabel(project.id)) : null };
}
async function inspectCommand(args, all = false) {
  const { options } = parseOptions(args); const id = options.positional[0] || ""; const current = registry(); const dns = dnsName();
  const projects = Object.values(current.projects).filter(project => all || !id || project.id === id);
  if (id && !projects.length) fail(`no preview has id ${id}.`, "not_found");
  const results = [];
  for (const project of projects.sort((a, b) => a.httpsPort - b.httpsPort)) results.push({ id: project.id, name: project.name, mode: project.mode, state: project.state, views: project.views, health: await healthFor(dns, current, project, options.verify), urls: current.gateway ? urls(dns, current, project) : null });
  const human = [`Dashboard: ${current.gateway ? urls(dns, current, projects[0] || { httpsPort: 0, views: { default: "/" }, primaryView: "default", id: "" }).dashboard : "not configured"}\n`];
  for (const item of results) human.push(`\n${item.id} — ${item.name}\n  Mode:   ${item.mode}\n  State:  ${item.state}\n  Local:  ${item.health.localRoute ? "healthy" : "unavailable"}\n  Direct: ${item.health.directTailnet === null ? "not verified" : item.health.directTailnet ? "healthy" : "unavailable"}\n  Viewer: ${item.urls?.viewer || "not configured"}\n`);
  emit({ ok: true, projects: results }, human.join(""));
}

async function sleepCommand(id) {
  if (!id) fail("sleep requires a preview id.", "invalid_argument"); const dns = dnsName();
  await withLock(async () => { const current = registry(); const project = current.projects[id]; if (!project) fail(`no preview has id ${id}.`, "not_found");
    const status = serveStatus(); const expected = project.transport === "gateway" ? `http://127.0.0.1:${current.gateway.localPort}` : `http://127.0.0.1:${project.localPort}`; const actual = proxyTarget(status, dns, project.httpsPort);
    if (actual && actual !== expected && !ownedTargets(current, project).has(actual)) fail(`refusing to stop listener ${project.httpsPort}; it belongs to ${actual}.`, "ownership_mismatch");
    if (actual) serveOff(project.httpsPort); if (project.mode === "supervised") stopService(project.launch?.label || appLabel(id)); project.state = "sleeping"; project.updatedAt = new Date().toISOString(); writeRegistry(current);
  }); emit({ ok: true, id, state: "sleeping" }, `Sleeping ${id}; identity and port leases retained.\n`);
}
async function removeCommand(id) {
  if (!id) fail("remove requires a preview id.", "invalid_argument"); const dns = dnsName();
  await withLock(async () => { const current = registry(); const project = current.projects[id]; if (!project) fail(`no preview has id ${id}.`, "not_found");
    const actual = proxyTarget(serveStatus(), dns, project.httpsPort); const expected = project.transport === "gateway" ? `http://127.0.0.1:${current.gateway.localPort}` : `http://127.0.0.1:${project.localPort}`;
    if (actual && actual !== expected && !ownedTargets(current, project).has(actual)) fail(`refusing to release listener ${project.httpsPort}; it belongs to ${actual}.`, "ownership_mismatch");
    if (actual) serveOff(project.httpsPort); if (project.mode === "supervised") stopService(project.launch?.label || appLabel(id)); delete current.projects[id]; writeRegistry(current); try { unlinkSync(join(stateDir, "launch", `${id}.json`)); } catch {}
  }); emit({ ok: true, id, state: "removed" }, `Removed ${id} and released its Tailnet listener.\n`);
}
async function doctorCommand() {
  const dns = dnsName(); const status = serveStatus(); const current = registry(); const reserved = new Set(Object.values(current.projects).map(project => project.localPort)); const localPort = await firstAvailable(devPortCandidates, reserved);
  const value = { ok: true, tailscale: "online", machine: dns, platform: platform(), supervisor: supervisor(), registryVersion: current.version, projects: Object.keys(current.projects).length, nextLocalPort: localPort, gateway: current.gateway };
  emit(value, `Tailscale: online\nMachine: ${dns}\nPlatform: ${platform()}\nSupervisor: ${supervisor()}\nRegistry: v${current.version} · ${value.projects} projects\nNext local port: ${localPort || "none"}\nOccupied Tailnet HTTPS ports: ${[...occupiedHttps(status)].sort((a,b)=>a-b).join(", ") || "none"}\n`);
}
async function reloadGatewayCommand() {
  const current = registry();
  if (!current.gateway) fail("no preview gateway is registered yet.", "gateway_not_configured");
  await withOperationLock("gateway", () => startGateway(current));
  emit({ ok: true, gateway: current.gateway }, "Reloaded the preview gateway. Project links and app processes were preserved.\n");
}

const filtered = process.argv.slice(2).filter(value => value !== "--json");
const [command = "help", ...args] = filtered;
try {
  if (command === "ensure") await ensureCommand(args);
  else if (command === "attach") await attachCommand(args);
  else if (command === "inspect") await inspectCommand(args);
  else if (command === "list") await inspectCommand(args, true);
  else if (command === "restart" || command === "resume") { const id = args[0]; const existing = registry().projects[id]; if (!existing || existing.mode !== "supervised") fail(`${id || "preview"} is not a supervised project.`, "not_supervised"); await ensureCommand([`--cwd=${existing.root}`, ...(command === "restart" ? ["--force-restart"] : [])], id); }
  else if (command === "sleep") await sleepCommand(args[0]);
  else if (command === "remove") await removeCommand(args[0]);
  else if (command === "doctor") await doctorCommand();
  else if (command === "reload-gateway") await reloadGatewayCommand();
  else if (["help", "--help", "-h"].includes(command)) usage();
  else { usage(); fail(`unknown command ${command}.`, "invalid_command"); }
} catch (error) {
  reportFailure(error);
}
