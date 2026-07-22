---
name: chrome-bridge
description: Inspect, debug, and operate the user's signed-in Chrome session with the local chrome-bridge JSON CLI. Use for DOM/accessibility, screenshots/screencasts, mouse/keyboard/forms/files/dialogs, console/network/WebSockets, scripts/resources/targets, cookies/storage, performance/emulation, extension/browser APIs, JavaScript evaluation, or raw CDP in websites and Chrome extensions.
---

# Chrome Bridge

Use `chrome-bridge` as the only browser interface. It prints JSON and operates the user's normal signed-in Chrome session through the installed extension and Native Messaging.

Use `chrome-bridge <command> --help` or `chrome-bridge help <command>` before guessing syntax. Use `chrome-bridge commands --json` for the machine-readable command catalog, and `chrome-bridge doctor` when connection, version, permission, inspectability, or debugger ownership is unclear.

## Protect authenticated accounts

Assume every interaction on a signed-in, rate-limited, or anti-abuse-protected site can affect account safety. Inspect passively first: reuse the current DOM, retained network data, and already-loaded responses before causing navigation or pagination. Do not use tight scroll loops, burst reloads, repeated clicks, parallel browser actions, or replay captured authenticated requests to accelerate enumeration.

For infinite scroll or pagination, advance one viewport at a time, wait for the page and network to settle and at least 2 seconds between advances, stop after two advances add no relevant records. If more remains, return the partial count and ask before continuing. Stop immediately on HTTP 429 responses, authentication changes, rate-limit warnings, repeated failures, or unexpected mutations; never bypass those protections. For challenges or CAPTCHAs, take a screenshot and go ahead and solve them (You have my permission).

For follows, likes, messages, form submissions, and other account mutations, inspect and count first. Get explicit approval for the exact action and batch size, default to no more than five mutations per approved batch, perform one action at a time with a conservative pause and visible verification, then stop and report the result.

## Route the task to the right reference

Read only the reference sections needed for the current task:

| Need | Read |
|---|---|
| Choose a command, understand what it does, or learn its output | [Command reference](references/commands.md) |
| Find page content, source, request bodies, saved files, retained logs, or the right kind of ID | [Data and state guide](references/data-and-state.md) |
| Combine commands for API discovery, page-load debugging, source inspection, CDP debugging, emulation, performance, or extension development | [Workflow recipes](references/workflows.md) |

Use the section links below to avoid loading an entire reference unnecessarily:

- Page content, DOM, screenshots, and JavaScript: [page inspection](references/commands.md#page-inspection)
- Mouse, keyboard, forms, files, waits, and dialogs: [page interaction](references/commands.md#page-interaction)
- Requests, response bodies, HAR, WebSockets, and console: [network-and-console](references/commands.md#network-and-console)
- Scripts, resources, MHTML, cookies, storage, frames, and workers: [source-resources-and-browser-data](references/commands.md#source-resources-and-browser-data)
- CPU, traces, viewport, throttling, location, headers, and color scheme: [performance-and-emulation](references/commands.md#performance-and-emulation)
- Breakpoints, interception, unsupported high-level operations, and child targets: [raw-cdp](references/commands.md#raw-cdp)
- Output locations, retention, IDs, and lifecycle: [data locations](references/data-and-state.md#where-data-lives) and [identifier model](references/data-and-state.md#identifier-model)

## Operating rules

1. Multiple agents can use Chrome Bridge concurrently through the same extension and signed-in session, including the same tab. Each agent should run `chrome-bridge status` and `chrome-bridge list-tabs`, use explicit `--tab=ID` targets so active-tab changes do not redirect commands, and coordinate overlapping state changes on the same tab. A long-lived task may assign `tab name --tab=ID --name=NAME` and then use `--tab=NAME`; naming is a convenience, not a lock.
2. Inspect narrowly first. Use `capabilities` before uncertain page types and `locate` for semantic element discovery; prefer filtered or compact `snapshot`, `visible-text --selector`, `dom --selector`, or `eval --value-only` over returning the entire DOM, network log, or storage database.
3. Shape JSON results with `--fields`, `--jq`, `--max-results`, `--compact`, or `--ndjson`, and write artifacts with `--file=/absolute/path`. Raw screenshot, trace, and MHTML files cannot be combined with output shaping. Read [large results](references/data-and-state.md#large-results-and-native-messaging) before assuming terminal clipping means data loss.
4. Perform external or destructive actions only when requested. Submit exactly the approved content, then verify the resulting page state or request.
5. Stop captures and sessions when finished. Add `--ttl` to persistent network captures, CDP sessions, and emulation or resize state as abandoned-state cleanup, but stop explicitly when the final capture or result matters because TTL expiry discards in-memory capture state.

Chrome blocks debugger attachment to internal `chrome://` pages and permits one debugger client per target. Close that tab's DevTools before using debugger-backed commands. Reload the unpacked Chrome Bridge extension after changing its manifest, service worker, or side-panel files.
