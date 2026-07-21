# Data and state guide

Use this reference to find a result, choose the correct ID, and understand when captured data stops being available.

## Contents

- [Where data lives](#where-data-lives)
- [How to find each kind of browser data](#how-to-find-each-kind-of-browser-data)
- [Identifier model](#identifier-model)
- [Network data lifecycle](#network-data-lifecycle)
- [Large results and Native Messaging](#large-results-and-native-messaging)
- [State lifetime and cleanup](#state-lifetime-and-cleanup)

## Where data lives

| Data | Location | Lifetime |
|---|---|---|
| Normal command result | JSON on stdout. | Until the caller or shell discards it. |
| Result written with `--file` | The exact absolute path supplied by the agent. | Persistent until that file is changed or deleted. |
| Full CLI request and response log | Native-host runtime `logs/` directory as `<command-id>.request.json` and `<command-id>.response.json`. | Persistent until **Clear logs** is clicked or the native host receives `clearLogs`. |
| Side-panel command list | `chrome.storage.local` audit log. | Latest 25 entries; **Clear logs** removes it. It stores metadata, not full payloads. |
| Expanded/copyable side-panel payload | Streamed on demand from the native-host `logs/` files. | Same lifetime as the retained log files. |
| Active capture, CDP session, emulation, and running-command state | Extension service-worker memory and the live status payload. | Until explicitly stopped, detached, tab removal/navigation cleanup, extension reload, or service-worker termination. |
| Request/response queue files | Native-host runtime `requests/` and `responses/`. | Requests are removed after forwarding; responses are removed after the waiting CLI consumes them. Do not use these as an archive. |

The runtime root is:

- macOS: `~/Library/Application Support/chrome-bridge`
- Linux: `${XDG_DATA_HOME:-~/.local/share}/chrome-bridge`
- Windows: `%LOCALAPPDATA%\chrome-bridge`
- Override: the absolute directory in `CHROME_BRIDGE_HOME`

The runtime also contains `config.json` for the extension ID and `state.json` for native-host PID, origin, connection state, and heartbeat time.

## How to find each kind of browser data

| Need | Primary command/data | Important distinction |
|---|---|---|
| Human-visible page content | `visible-text` or `snapshot` | `visible-text` is plain text; `snapshot` adds roles, labels, values, and states for grounding. |
| Current page markup | `dom` | Reflects the live DOM after JavaScript mutations. |
| Original or loaded source | `scripts list/get` or `resources tree/get` | Runtime script source and resource response content are different from serialized DOM. |
| Full page archive | `page mhtml --file=...` | Preserves the document and resource payloads together. |
| Element appearance | `styles --selector=...` | Returns computed and matched CSS, not a screenshot. |
| Visual evidence | `screenshot --file=...` | `--selector` limits capture to one element. |
| Requests and response metadata | `network capture` or `network start/tail/stop` | Only traffic after CDP attachment is visible. Start before the action or reload. |
| One response body | `network get-body` | Fetch while the capture is still attached. |
| Bodies retained in final network output | Capture with `--bodies` | The bridge fetches bodies at request completion and embeds them in records. |
| WebSocket messages | Network capture's `webSockets` array | Includes sent and received frames with payloads. |
| Console and runtime failures | `console capture` | Start before reproducing the event. |
| Cookies | `cookies` | Returns cookies applicable to the current tab URL. |
| Local/session storage, IndexedDB, caches | `storage` | Add `--bodies` for Cache API response bodies. |
| Frames, workers, extension service workers | `targets` | Use returned target IDs with raw CDP. |
| Current performance counters | `performance metrics` | A point-in-time result, unlike a profile or trace. |
| CPU samples | `performance profile` | V8 sampling profile for the requested interval. |
| Detailed performance timeline | `performance trace --file=...` | Raw trace evidence for later analysis. |

## Identifier model

These IDs are not interchangeable:

| Identifier | Comes from | Used by | Meaning |
|---|---|---|---|
| Tab ID | `list-tabs` | Most page commands via `--tab` | Chrome's stable identifier for an open tab. |
| Target ID | `targets` | `cdp send`, `cdp events`, `cdp session-start` via `--target` | A page, iframe, worker, service worker, or extension debuggee. It may change after reload/restart. |
| Bridge session ID | `cdp session-start` | Raw CDP via `--bridge-session` | Chrome Bridge's owner for a persistent root debugger attachment. |
| Child CDP session ID | `Target.attachedToTarget` event | Raw CDP via `--session-id` | CDP's flat route from the attached root into a child target. |
| Network capture session ID | `network start` | `network tail/get-body/stop` via `--session` | One active network collection owned by a tab. |
| Request key | Network capture record | `network get-body --request` | Composite `root-or-child-session:requestId`, preventing collisions across attached targets. |
| Request ID | Network capture record | Also accepted by `network get-body` when unique | Chrome's request identifier inside one CDP session. |
| Script ID | `scripts list` or `Debugger.scriptParsed` | Raw `Debugger.getScriptSource` | Runtime identifier for a parsed script; it can change after reload. |
| Frame ID | `resources tree` | `resources get --frame` | CDP identifier for a document frame. |
| Command ID | Audit/log entry | Native-host log filenames and side-panel expansion | UUID joining a CLI request, its response, and its audit metadata. |

## Network data lifecycle

1. `network start` attaches CDP, enables Network, recursively auto-attaches supported child targets, and returns a capture session ID.
2. Request and WebSocket events accumulate in extension memory. `network tail` returns the current snapshot without stopping it.
3. `network get-body` calls CDP for a completed request while the debugger is still attached.
4. With `--bodies`, the bridge fetches bodies as requests finish and stores them inside the final records.
5. `network stop` waits for pending body reads, returns the final snapshot or HAR, removes the capture from memory, and detaches its debugger owner.

Starting a capture does not include requests that happened before attachment. For an initial page load, start the capture, reload, wait for the page, then stop. If a body was neither fetched before stop nor retained with `--bodies`, it is not available afterward from that capture.

## Large results and Native Messaging

Chrome imposes per-frame Native Messaging limits, so the bridge splits requests and responses into frames and reassembles them. It does not apply a total payload cap or redact data.

Use `--file` for DOM dumps, network captures with bodies, storage exports, screenshots, MHTML, CPU profiles, and traces. The CLI writes:

- Screenshot: decoded PNG or JPEG bytes.
- Performance trace and MHTML: raw returned data.
- Every other command: formatted JSON containing the complete result.

If a terminal, shell integration, or agent context shows only part of stdout, inspect the file written by `--file` or the retained native-host response log. Do not rerun a large capture merely because the display layer clipped it.

## State lifetime and cleanup

| State | Starts with | Normal cleanup |
|---|---|---|
| Network capture | `network start` | `network stop --session=...` |
| Persistent CDP | `cdp session-start` | `cdp session-stop --bridge-session=...` |
| Persistent emulation/resize | `emulate` or `resize` | `emulate --clear` |
| Timed console, network, screencast, profile, trace, or CDP events | Its timed command | Ends automatically after the duration. |

Use `status` to see active owners. Use `detach --tab=ID` when targeted cleanup cannot complete; it removes every Chrome Bridge debugger owner for that tab. Reloading Chrome Bridge also drops in-memory state, but use explicit cleanup so the browser returns to a known state before the task ends.
