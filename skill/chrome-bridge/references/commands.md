# Command reference

Use this reference to choose a command and understand what it does, when to use it, and what data it returns. For output locations, retention, and identifiers, read [data-and-state.md](data-and-state.md). For multi-command sequences, read [workflows.md](workflows.md).

## Contents

- [Common behavior](#common-behavior)
- [Connection and tabs](#connection-and-tabs)
- [Page inspection](#page-inspection)
- [Page interaction](#page-interaction)
- [Network and console](#network-and-console)
- [Source, resources, and browser data](#source-resources-and-browser-data)
- [Performance and emulation](#performance-and-emulation)
- [Browser-wide and extension control](#browser-wide-and-extension-control)
- [Raw CDP](#raw-cdp)

## Common behavior

Every command prints JSON to stdout. `--timeout=30s` bounds how long the CLI waits for Chrome. Shape JSON results in this order: `--jq` filters the raw result with the installed `jq` executable, `--fields=url,title` projects top-level fields, `--max-results=100` limits a result array and top-level array fields, and `--compact` or `--ndjson` controls serialization. `--file=/absolute/path` writes that shaped JSON and returns an artifact receipt containing its absolute path, SHA-256, byte count, capture time, format, bridge version, and page metadata when available. Raw screenshot, performance-trace, and MHTML artifacts reject output-shaping flags because their files must remain valid binary or raw data. `upload-file` uses `--file` as input, so use `--out` for its result. Durations accept `ms`, `s`, `m`, or `h`.

Run `chrome-bridge <command> --help` or `chrome-bridge help <command>` for syntax, required and optional arguments, defaults, side effects, debugger behavior, examples, and output shape. `chrome-bridge commands --json` returns the same catalog for automatic validation. Invalid commands and options include a likely correction and executable syntax.

Read-only page commands accept `--tab=ID`; omit it only when the active tab is unambiguous. Commands that can change browser state require an explicit tab ID. Commands that use CDP temporarily attach the debugger unless an active capture, emulation, or persistent session already owns the tab.

## Connection and tabs

| Command | Use it for | What it returns or changes |
|---|---|---|
| `status` | Check whether the native host and extension are connected and see live bridge activity. | Connection and version fields, running commands, attached tabs, active captures, persistent CDP sessions, emulated tabs, activity counters, and the latest 25 audited commands. |
| `doctor` | Diagnose installation and runtime failures without changing page data. | CLI, native-host, extension, and protocol versions; connection, permission, inspectability, debugger ownership, and a harmless CDP evaluation. |
| `inspectability --tab=ID` | Check Chrome security boundaries before a debugger-backed command. | Scheme, owning extension ID, inspectability reason, debugger owner, and whether returning to HTTP(S) would restore access. |
| `capabilities --tab=ID` | Check which operations the current page type can support before attempting them. | DOM, accessibility, screenshot, evaluation, debugger, network, storage, input, and extension-page capability flags with reasons. |
| `list-tabs` | Discover the tab ID or saved name to use for later commands. | Every tab's ID, optional name, window ID, title, URL, active state, and attachment state. |
| `tab name --tab=ID --name=NAME` | Give a tab a memorable local alias that survives ID changes when its saved URL identifies exactly one open tab. | The name, current tab ID, URL, and title; later commands accept `--tab=NAME`. Assigning another name to the same tab removes its previous alias. |
| `new-tab [URL]` | Open a page without reusing an existing tab. | The created Chrome tab object. Use `--active=false` to keep it in the background. |
| `close-tab --tab=ID` | Close a specific tab. | A confirmation containing the closed tab ID. |
| `activate-tab --tab=ID` | Bring a tab to the front before an interaction that requires visibility. | The updated Chrome tab object. |
| `navigate --tab=ID --url=URL` | Load a new URL in an existing tab. | Final URL/title plus optional `--wait=load`, `--wait-for-url`, or `--wait-for-selector` outcome. Reload and history navigation accept the same waits. |
| `reload --tab=ID` | Reproduce an initial load, refresh application state, or rerun extension content scripts. | A reload confirmation and final tab state after any requested wait. |
| `go-back --tab=ID` / `go-forward --tab=ID` | Move through that tab's history. | A navigation confirmation. |
| `detach --tab=ID` | Force cleanup when a capture, emulation, or debugger session is stuck. | A confirmation after every Chrome Bridge debugger owner for the tab is removed. |
| `audit` | Review the compact command history used by the side panel. | Filter with `--status`, `--command`, or `--since=1h`; `--summary` returns counts by status and command. It does not contain full request or response payloads. |

## Page inspection

| Command | Use it for | What it returns or changes |
|---|---|---|
| `snapshot --tab=ID` | Ground controls and content semantically before interacting. | Accessibility nodes and backend DOM node IDs. Filter with `--selector`, `--role`, `--name`, `--depth`, or `--max-nodes`; `--compact` returns interaction-relevant fields. |
| `snapshot diff --before=FILE --after=FILE` | Verify semantic changes between two saved JSON snapshots without contacting Chrome. | Added, removed, and changed paths plus counts, keyed by backend node ID when snapshots contain nodes. It does not retain or query live tab history. |
| `locate --tab=ID` | Discover an element from visible text, role, or accessible name before acting. | Matches with accessible metadata, backend node IDs, visibility, enabled state, coordinates, suggested unique selectors, and stability warnings. |
| `watch --tab=ID` | Wait for `--url-changes`, `--selector`, `--request=GLOB`, or `--console=error|warning|all` without shell polling. | The matched state, events, and elapsed time; specify exactly one condition. Request and console watches need debugger access, so external DevTools blocks them; a request watch also fails when that tab already has a network capture. |
| `dom --tab=ID` | Read the page's current rendered HTML after client-side changes. | Full live document HTML, or one subtree with `--selector`. |
| `dom snapshot --tab=ID` | Analyze layout, paint order, DOM rectangles, and selected computed styles at scale. | CDP `DOMSnapshot.captureSnapshot` documents, strings, layout nodes, text boxes, and computed-style indexes. Use `--styles=CSV` to choose properties. |
| `visible-text --tab=ID` | Quickly read what the page visibly says without HTML or accessibility metadata. | `innerText` for the body or the element selected by `--selector`. |
| `styles --tab=ID --selector=CSS` | Explain why one element looks or lays out a certain way. | Its DOM node ID, attributes, full computed style, inline style, matched rules, inherited rules, pseudo-element rules, and keyframes. |
| `screenshot --tab=ID` | Capture visual evidence of the page or one element. | Base64 PNG or JPEG plus format and tab ID; with `--file`, writes the binary image. Use `--selector=CSS`, `--format=jpeg`, or `--quality=N` as needed. |
| `screencast --tab=ID` | Capture a short sequence of rendered frames when motion or state transitions matter. | JSON containing CDP screencast frames and metadata. It does not transcode frames into a video. Options include duration, format, quality, dimensions, and frame sampling. |
| `eval --tab=ID JAVASCRIPT` | Ask a narrow page-specific question or perform an operation not covered by a high-level command. | A CDP remote object, or its serializable value with `--value-only`. It awaits promises and surfaces JavaScript exceptions. |

Choose `snapshot` for meaning, `dom` for current markup, `dom snapshot` for rendering internals, `visible-text` for a quick read, and `eval` for a targeted custom query.

## Page interaction

| Command | Use it for | What it returns or changes |
|---|---|---|
| `click --tab=ID` | Click a grounded element or exact viewport coordinate with real CDP mouse events. | Target with `--backend-node-id` from `snapshot`, `--selector`, or `--x --y`. Returns outcome, side-effect ambiguity, before/final URLs, title, point, and optional atomic wait result. |
| `hover --tab=ID` | Open hover menus, trigger tooltips, or inspect hover styles. | The final mouse point and element summary. Accepts a selector or coordinates. |
| `drag --tab=ID` | Perform an HTML drag-and-drop operation with intercepted CDP drag data. | Source and destination points after Chrome dispatches drag enter, over, and drop. Use source/destination selectors or coordinate pairs. |
| `type --tab=ID --selector=CSS --text=TEXT` | Replace the contents of a specific input, textarea, or contenteditable element. | The element tag and inserted character count. It focuses and selects the target before inserting text. |
| `type-text --tab=ID --text=TEXT` | Continue typing into the element that is already focused. | The inserted character count. It does not locate or clear an element first. |
| `press-key --tab=ID KEY` | Trigger shortcuts, submit forms, dismiss UI, or use navigation keys. | The normalized key, code, modifier mask, and virtual key code sent to Chrome. Accepts `Enter`, `Escape`, `Meta+A`, `Control+Shift+R`, and similar combinations. |
| `fill-form --tab=ID --elements=JSON` | Fill several inputs, selects, checkboxes, or radios in one command. | An array identifying every selector and element tag changed. Each JSON item needs `selector` and `value`. |
| `upload-file --tab=ID --selector=CSS` | Put local files into an existing `<input type=file>`. | The selector and file paths passed to Chrome. Use `--file=PATH` or `--files='["PATH1","PATH2"]'`; use `--out=PATH` for the result receipt. |
| `wait-for --tab=ID` | Synchronize with a page condition instead of guessing with sleep. | `{matched:true, elapsedMs}` or a timeout error. Wait for `--selector`, `--text`, or a truthy `--expression`; set the maximum with `--duration`. |
| `handle-dialog --tab=ID --action=accept|dismiss` | Resolve an open JavaScript alert, confirm, or prompt. | The action sent to Chrome. Add `--prompt-text=TEXT` when accepting a prompt. |

Inspect before acting, use the most stable available selector, and verify the resulting state after any side effect.

## Network and console

| Command | Use it for | What it returns or changes |
|---|---|---|
| `network capture --tab=ID` | Observe traffic for a fixed period or a complete initial load. | Use `--reload --wait=network-idle --bodies` to attach before reload, stop after the network settles, retain bodies before cleanup, and report exactly what was captured. |
| `network start --tab=ID` | Begin a capture that must span later CLI commands or a manual user action. | A network capture session ID, tab ID, start time, and optional `--ttl`; expiry stops and removes the capture. |
| `network tail --tab=ID --session=ID` | Inspect an active capture without stopping it. | Raw requests, grouped GraphQL operations with `--graphql`, or focused output with `--websockets`, `--event-stream`, or `--errors-only`. |
| `network get-body --tab=ID --session=ID --request=REQUEST_KEY` | Fetch one complete response body while its capture is still attached. | `{base64Encoded, body}` from CDP, plus parsed JSON with `--pretty`. Use the `requestKey` or raw `requestId`. |
| `network stop --tab=ID --session=ID` | Finish a started capture and release its debugger owner. | The final network snapshot, or a HAR object with `--har`. Bodies are present only if they were requested or captured with `--bodies`. |
| `network export-har --tab=ID` | Record a timed flow directly in HAR 1.2 structure. | A HAR object with pages and request/response entries. Use `--bodies` to include retained response text. |
| `console capture --tab=ID` | Collect console calls, uncaught exceptions, and browser log entries during a time window. | Start time plus ordered events from `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, and `Log.entryAdded`, including stack data when Chrome provides it. |

Network request records include URL, method, request headers and payload, initiator, type, timing, response status and headers, protocol, cache/service-worker origin, completion size, failures, and optional body. WebSocket records include direction, time, opcode, and payload.

## Source, resources, and browser data

| Command | Use it for | What it returns or changes |
|---|---|---|
| `scripts list --tab=ID` | Inventory JavaScript currently known to the debugger, including bundles and dynamically evaluated scripts. | Script IDs, URLs, source ranges, hashes, and module flags. |
| `scripts get --tab=ID --url=TEXT` | Retrieve a loaded script's runtime source. | The matched URL, script ID, and complete script source. URL matching accepts an exact URL or substring. |
| `resources tree --tab=ID` | Discover the page frame hierarchy and its loaded document, stylesheet, image, font, and script resources. | CDP's frame/resource tree with frame IDs and resource URLs. |
| `resources get --tab=ID --frame=FRAME_ID --url=URL` | Fetch a resource discovered in the resource tree. | Resource URL, content, and whether Chrome encoded the content as base64. |
| `page mhtml --tab=ID` | Preserve a self-contained snapshot of the page and its resources. | Raw MHTML data; with `--file`, writes the archive directly. |
| `cookies --tab=ID` | Read cookies applicable to the tab's current URL. | Complete CDP cookie objects, including values, domain/path, expiry, SameSite, Secure, HttpOnly, priority, partition information, and source scheme. |
| `storage --tab=ID` | Inspect origin-owned browser storage in one request. | Local storage, session storage, IndexedDB databases/records, and Cache API entries. Add `--bodies` to include cached response bodies. |
| `targets` | Discover page, iframe, worker, service-worker, and extension targets for raw CDP. | Without `--tab`, Chrome's debugger-target inventory. With a tab, also returns that page's frame tree. |

Use `dom` for the current rendered document, `scripts get` for debugger-known runtime code, `resources get` for a loaded resource response, and `page mhtml` for an archive.

## Performance and emulation

| Command | Use it for | What it returns or changes |
|---|---|---|
| `performance metrics --tab=ID` | Get a lightweight current measurement without recording a trace. | CDP performance metrics plus JavaScript heap usage. |
| `performance profile --tab=ID` | Find CPU-heavy JavaScript during a specific interval. | A V8 CPU profile with nodes, samples, time deltas, and start/end times. Use `--duration` and optional sampling `--interval`. |
| `performance trace --tab=ID` | Capture detailed loading, rendering, scripting, and user-timing events for offline analysis. | Raw trace JSON. Use `--categories` or a full `--trace-config`; prefer `--file` because traces are large. |
| `resize --tab=ID --width=N --height=N` | Set an exact emulated content viewport. | The width, height, and persistent-state confirmation. It remains active until `emulate --clear`, `detach`, or optional `--ttl` expiry. |
| `emulate --tab=ID` | Reproduce device, CPU, location, user-agent, media, header, offline, or bandwidth conditions. | A persistent-state confirmation after applying overrides; optional `--ttl` resets them automatically. |
| `emulate --tab=ID --clear` | Restore normal browser conditions and release the emulation debugger owner. | `{cleared:true}` after resetting device, location, CPU, network, and extra-header overrides. |

Emulation options include `--viewport=WIDTHxHEIGHTxDPR`, `--mobile`, `--cpu=RATE`, latitude/longitude/accuracy, user agent, `--color-scheme`, JSON headers, offline state, latency, and download/upload throughput in bytes per second.

## Browser-wide and extension control

| Command | Use it for | What it returns or changes |
|---|---|---|
| `history search` | Find pages in Chrome history by text and time. | Matching history items. Use `--query`, `--start-time=EPOCH_MS`, and `--limit`. |
| `bookmarks tree` | Inspect the complete bookmark hierarchy. | Nested bookmark folders and URL entries. |
| `bookmarks search` | Find bookmarks by title or URL text. | Matching bookmark nodes. |
| `downloads search` | Inspect Chrome's download records. | Matching download items ordered newest first. Use `--query` and `--limit`. |
| `extensions list` | Discover installed extension IDs and states before debugging or reloading another extension. | Chrome management records with ID, name, version, type, enabled state, permissions, install type, and icons. |
| `extension reload --extension=ID` | Restart another unpacked extension after code changes. | A confirmation with the extension's ID, name, and type. Chrome Bridge cannot reload itself through this command. |
| `chrome call --api=NAMESPACE --method=METHOD --args=JSON` | Reach a granted Chrome Extension API that has no dedicated high-level command. | The raw promise result from that Chrome API method. `--args` must be a JSON array in method argument order. |

## Raw CDP

| Command | Use it for | What it returns or changes |
|---|---|---|
| `cdp send` | Invoke any syntactically valid CDP method when no high-level command exposes it. | Chrome's raw protocol result or protocol error. Target with `--tab`, `--target`, or `--bridge-session`; pass method parameters as JSON. |
| `cdp events` | Collect every event from one CDP domain for a fixed interval. | An ordered array of method, parameters, source debuggee, and timestamp. It attempts `Domain.enable` first and accepts `--enable-params`. |
| `cdp session-start` | Keep debugger state across commands for breakpoints, Fetch interception, enabled domains, or a non-tab target. | A bridge session ID, root debuggee, start time, and optional `--ttl` that releases abandoned sessions. |
| `cdp session-stop` | End a persistent CDP session and release its debugger owner. | A stop confirmation containing the bridge session ID and target. |

`--session-id=CHILD_SESSION` routes a command through a flat child CDP target and is different from `--bridge-session`. Chrome's MV3 debugger API intentionally withholds some browser-process and heap-profiler domains; Chrome Bridge returns Chrome's protocol error rather than hiding the method.
