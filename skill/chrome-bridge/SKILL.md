---
name: chrome-bridge
description: Inspect, debug, and fully operate the user's existing signed-in Chrome session through the local chrome-bridge JSON CLI, without MCP or a separate automation profile. Use for live DOM, accessibility, styles, scripts, resources, console, network bodies, WebSockets, storage, cookies, targets, screenshots, screencasts, performance, emulation, dialogs, file upload, real mouse and keyboard input, extension management, browser APIs, JavaScript evaluation, or stateful raw CDP while developing websites and Chrome extensions.
---

# Chrome Bridge

Use `chrome-bridge` as the only browser interface. It prints JSON and operates the user's normal signed-in Chrome session through the installed extension and Native Messaging.

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

1. Run `chrome-bridge status` and `chrome-bridge list-tabs`, then select the intended tab explicitly with `--tab=ID`.
2. Inspect narrowly first. Prefer a targeted `eval` or semantic `snapshot` over returning the entire DOM, network log, or storage database.
3. Write large results with `--file=/absolute/path`; read [large results](references/data-and-state.md#large-results-and-native-messaging) before assuming terminal clipping means data loss.
4. Perform external or destructive actions only when requested. Submit exactly the approved content, then verify the resulting page state or request.
5. Stop captures and sessions when finished. Read [state lifetime and cleanup](references/data-and-state.md#state-lifetime-and-cleanup) when a debugger, capture, or emulation state may remain active.

Chrome blocks debugger attachment to internal `chrome://` pages and permits one debugger client per target. Close that tab's DevTools before using debugger-backed commands. Reload the unpacked Chrome Bridge extension after changing its manifest, service worker, or side-panel files.
