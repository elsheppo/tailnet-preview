#!/usr/bin/env node
import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { createManagement, machineName } from "./management.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const valueFor = (flag, fallback = "") => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const host = valueFor("--host", "127.0.0.1");
const port = Number(valueFor("--port", "4310"));
const stateDir = valueFor("--state-dir");
if (!Number.isInteger(port) || !stateDir || host !== "127.0.0.1") {
  console.error("Tailnet Preview gateway: loopback --host, valid --port, and --state-dir are required.");
  process.exit(2);
}

const dashboardTemplate = await readFile(join(here, "../assets/dashboard.html"), "utf8");
const viewerTemplate = await readFile(join(here, "../assets/viewer.html"), "utf8");

async function registry() {
  try {
    const value = JSON.parse(await readFile(join(stateDir, "registry.json"), "utf8"));
    return value?.version === 3 ? value : { version: 3, gateway: null, projects: {} };
  } catch {
    return { version: 3, gateway: null, projects: {} };
  }
}

async function showAuthorCredit() {
  try {
    const settings = JSON.parse(await readFile(join(stateDir, 'settings.json'), 'utf8'));
    return settings.showAuthorCredit !== false;
  } catch { return true; }
}

const management = createManagement({ stateDir, helper: join(here, "preview.mjs"), registry, dnsName: await machineName(), localPort: port });

function localRouteHealthy(project, route, timeout = 900) {
  return new Promise(resolve => {
    const request = httpRequest({ hostname: "127.0.0.1", port: project.localPort, path: route, timeout }, response => {
      response.resume();
      response.once("end", () => resolve(Boolean(response.statusCode && response.statusCode < 500)));
    });
    request.once("timeout", () => request.destroy(new Error("timeout")));
    request.once("error", () => resolve(false));
    request.end();
  });
}

function inject(template, configuration) {
  return template.replace("__PREVIEW_CONFIG_JSON__", () => JSON.stringify(configuration).replaceAll("<", "\\u003c"));
}


// Only browser snapshots explicitly imported for an existing named view enter the UI.
// No directory or arbitrary file is exposed through the gateway.
async function thumbnail(project) {
  if (!/^[a-z0-9-]+$/.test(project.id)) return null;
  try {
    const value = JSON.parse(await readFile(join(stateDir, "thumbnails", project.id + ".json"), "utf8"));
    if (value.version !== 1 || !value.view || value.route !== project.views?.[value.view] ||
        typeof value.dataUrl !== "string" || value.dataUrl.length > 2800000 ||
        !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(value.dataUrl) ||
        !Number.isFinite(Date.parse(value.capturedAt))) return null;
    return { view: value.view, capturedAt: value.capturedAt, dataUrl: value.dataUrl };
  } catch { return null; }
}
function projectNavigation(current) {
  return Object.values(current.projects || {}).map(item => ({
    id: item.id, name: item.name, primaryView: item.primaryView,
    views: item.views || { default: "/" }, updatedAt: item.updatedAt,
  })).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
}

function externalPort(hostHeader, fallback) {
  const match = String(hostHeader || "").match(/:(\d+)$/);
  return match ? Number(match[1]) : fallback;
}

function publicHeaders() {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src https:; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function proxyRequest(request, response, project) {
  const headers = { ...request.headers, host: `127.0.0.1:${project.localPort}` };
  delete headers["proxy-connection"];
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: project.localPort,
    method: request.method,
    path: request.url,
    headers,
  }, upstreamResponse => {
    response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.once("error", () => {
    if (!response.headersSent) response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(`Tailnet Preview: ${project.name} is not reachable.\n`);
  });
  request.pipe(upstream);
}

const server = createServer(async (request, response) => {
  const current = await registry();
  const incomingPort = externalPort(request.headers.host, current.gateway?.httpsPort || 443);
  const project = Object.values(current.projects || {}).find(candidate => candidate.httpsPort === incomingPort && candidate.state !== "sleeping");
  if (project) {
    proxyRequest(request, response, project);
    return;
  }

  if (!management.allowedHost(request.headers.host || "", current.gateway?.httpsPort || 443)) {
    response.writeHead(403); response.end("Unknown preview host."); return;
  }
  const url = new URL(request.url || "/", `http://${request.headers.host}`);
  if (url.pathname === "/_tailnet-preview/action") {
    await management.handle(request, response, current); return;
  }
  const headers = publicHeaders();
  if (url.pathname === "/_tailnet-preview/health") {
    response.writeHead(200, { ...headers, "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, version: 3, projects: Object.keys(current.projects || {}) }));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    const projects = await Promise.all(Object.values(current.projects || {}).map(async item => ({
      id: item.id,
      name: item.name,
      httpsPort: item.httpsPort,
      mode: item.mode,
      state: item.state,
      healthy: item.state !== "sleeping" && await localRouteHealthy(item, item.views?.[item.primaryView] || "/"),
      views: item.views || { default: "/" },
      primaryView: item.primaryView, updatedAt: item.updatedAt, thumbnail: await thumbnail(item),
    })));
    response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    response.end(inject(dashboardTemplate, { projects, managementToken: management.token, showAuthorCredit: await showAuthorCredit(), checkedAt: new Date().toISOString() }));
    return;
  }

  const match = url.pathname.match(/^\/p\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/);
  if (match) {
    const item = current.projects?.[match[1]];
    const view = match[2] || item?.primaryView || "default";
    const route = item?.views?.[view];
    if (!item || !route) {
      response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
      response.end("That preview or view is not configured.\n");
      return;
    }
    const healthy = item.state !== "sleeping" && await localRouteHealthy(item, route);
    response.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    response.end(inject(viewerTemplate, {
      id: item.id, name: item.name, appPort: item.httpsPort, view, route, views: item.views, healthy, mode: item.mode,
      state: item.state, managementToken: management.token, checkedAt: new Date().toISOString(), projects: projectNavigation(current),
    }));
    return;
  }

  response.writeHead(404, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
  response.end("Tailnet Preview page not found.\n");
});

server.on("upgrade", async (request, socket, head) => {
  const current = await registry();
  const incomingPort = externalPort(request.headers.host, current.gateway?.httpsPort || 443);
  const project = Object.values(current.projects || {}).find(candidate => candidate.httpsPort === incomingPort && candidate.state !== "sleeping");
  if (!project) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const upstream = net.createConnection({ host: "127.0.0.1", port: project.localPort }, () => {
    const headers = { ...request.headers, host: `127.0.0.1:${project.localPort}` };
    const lines = [`${request.method} ${request.url} HTTP/${request.httpVersion}`];
    for (const [name, value] of Object.entries(headers)) {
      if (value !== undefined) lines.push(`${name}: ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.once("error", () => socket.destroy());
  socket.once("error", () => upstream.destroy());
});

server.listen(port, host, () => console.log(`Tailnet Preview gateway listening on http://${host}:${port}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
