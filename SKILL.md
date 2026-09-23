---
name: tailnet-preview
description: Privately run, revive, expose, and inspect one or more local web development sites from trusted Tailscale devices. Use for remote localhost previews, mobile or desktop breakpoint viewing, concurrent preview allocation, or Tailnet Preview lifecycle management.
---

# Tailnet Preview

Use the bundled `scripts/preview` helper as the lifecycle protocol. Resolve it from this skill's installed directory and invoke it by absolute path while your working directory is the app project. It owns the private gateway, registered Tailscale Serve listeners, preview identities, and supervised app processes it starts.

## Invariants

- Use Tailscale Serve, never Funnel.
- Bind apps and the gateway to `127.0.0.1`, never `0.0.0.0`.
- Proxy HTTP apps only. Never serve a repository, directory, secret, or arbitrary file.
- Preserve unrelated Serve configuration. Change only listeners proven free or owned by Tailnet Preview.
- Never change tailnet ACLs, HTTPS policy, device names, tags, or host settings without separate user authorization.
- Do not persist shell strings or secret-bearing environments. Supervised commands are argument arrays executed as the current user.
- Treat one project as one app identity. Add named route views instead of registering the same server as several projects.

## Start or revive a project

Prefer supervised mode. From the project root run one command with a stable ID:

```bash
"/path/to/installed/tailnet-preview/scripts/preview" ensure --json --id=my-site --name="My Site" --route='/' -- npm run dev
```

`ensure` is idempotent. It reuses the project identity and ports, starts or revives its app, ensures the gateway and Tailnet listener, verifies the configured route, and prints one receipt.

If the project may already have a Tailnet Preview, run the helper's `list` command first and reuse its ID. Do not create a second identity for another view of the same app; add a named `--view` to the existing identity.

For a server deliberately owned elsewhere, attach without claiming durability:

```bash
"/path/to/installed/tailnet-preview/scripts/preview" attach 3000 --id=my-site --name="My Site" --route='/'
```

An attached preview is available only while that external process remains alive.

On Codex desktop for macOS, Tailscale-facing helper calls normally require approved execution outside the default sandbox. Request that narrow approval on the first call instead of retrying after `Failed to load preferences`.

Use `--json` for automated lifecycle mutations and verification. Structured failures include a stable error code and, when an app cannot start, the supervisor log path and the intended corrective action.

Supervised commands inherit a safe snapshot of the invoking `PATH`, so ordinary `npm`, `pnpm`, `yarn`, and `bun` commands should resolve as they do in the current shell. If a registration reports `spawn <tool> ENOENT` or `/usr/bin/env: node: No such file or directory`, keep the same preview ID and rerun `ensure` once with an explicit Node executable followed by the package-manager script, for example:

```bash
"/path/to/installed/tailnet-preview/scripts/preview" ensure --json --id=my-site --name="My Site" --route='/' -- /absolute/path/to/node /absolute/path/to/pnpm run dev
```

Use `attach` only when the app process is deliberately owned elsewhere. A supervised launch failure is not by itself a reason to downgrade the preview to attached mode.

## Commands

- `preview ensure ... -- <argv...>` — supervise and expose one project.
- `preview attach <port> ...` — expose an externally owned process.
- `preview inspect [id] [--verify]` — show lifecycle and layered health.
- `preview list` — show all project identities and views.
- `preview restart <id>` — restart a supervised app without changing its URLs.
- `preview sleep <id>` — stop its process and listener but retain identity and port leases.
- `preview resume <id>` — restore a supervised sleeping project.
- `preview remove <id>` — remove only that project and release its listener.
- `preview reload-gateway` — load updated browser assets from the stable installed path without changing project links or app processes.
- `preview doctor` — inspect system readiness; do not run it with `list` and a separate port command as mandatory preflight.

Quote route arguments containing `?` or `#`. Pass additional views as `--view=name=/path`; names use lowercase letters, digits, and hyphens.

## Browser instance controls

The project library's Instance menu and the viewer's instance menu expose Start, Stop, Restart, and Remove for supervised apps. Stop retains the project and its URLs; Remove releases the registration and listener while preserving source files. Attached apps offer Disconnect and Remove, which leave the externally owned process running. Stop, Restart, Disconnect, and Remove ask for project-specific confirmation in the interface, with Cancel focused by default. Start and Pin remain immediate.

These controls invoke the same lifecycle helper with fixed arguments. They are available to trusted users/devices that can reach the gateway; there is no separate administrator role. Exact gateway-origin checks and a per-process token prevent embedded preview apps from issuing management requests. Refresh a page after a gateway restart before managing an instance. Browser resume/restart preserves the app's saved executable PATH.

## Reporting

Report the Dashboard and project Viewer URLs first, then the direct URL, preview ID, lifecycle mode, and health. Say “supervised” only for apps started by `ensure`. Say “attached; external process must remain running” for `attach`.

Do not report success unless local route, direct Tailnet route, and viewer checks pass. If the helper returns a structured corrective action, perform only that action and retry once; do not reset Serve or take another project’s port.

## Optional repository configuration

For repeated use, `.tailnet-preview.json` may define `id`, `name`, `command` as an argv array, `route`, and `views`. It must not contain secrets. `{port}` is the only supported command placeholder. Explicit CLI arguments override configuration.
