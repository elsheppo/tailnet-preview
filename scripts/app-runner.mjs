#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const valueFor = flag => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
};

const stateDir = valueFor("--state-dir");
const id = valueFor("--id");
if (!stateDir || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) {
  console.error("Tailnet Preview runner: --state-dir and a valid --id are required.");
  process.exit(2);
}

let launch;
try {
  launch = JSON.parse(readFileSync(join(stateDir, "launch", `${id}.json`), "utf8"));
} catch (error) {
  console.error(`Tailnet Preview runner: could not read launch record for ${id}: ${error.message}`);
  process.exit(1);
}

if (!Array.isArray(launch.argv) || !launch.argv.length || typeof launch.cwd !== "string") {
  console.error(`Tailnet Preview runner: invalid launch record for ${id}.`);
  process.exit(1);
}

const allowedEnvironment = ["HOME", "PATH", "TMPDIR", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "TERM"];
const environment = Object.fromEntries(allowedEnvironment.flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
Object.assign(environment, launch.env || {});

const child = spawn(launch.argv[0], launch.argv.slice(1), {
  cwd: launch.cwd,
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", error => {
  console.error(`Tailnet Preview runner: ${error.message}`);
  process.exit(1);
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
