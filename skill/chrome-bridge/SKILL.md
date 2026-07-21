---
name: chrome-bridge
description: Inspect, debug, and fully operate the user's existing signed-in Chrome session through the local chrome-bridge JSON CLI, without MCP or a separate automation profile. Use for live DOM, accessibility, styles, scripts, resources, console, network bodies, WebSockets, storage, cookies, targets, screenshots, screencasts, performance, emulation, dialogs, file upload, real mouse and keyboard input, extension management, browser APIs, JavaScript evaluation, or stateful raw CDP while developing websites and Chrome extensions.
---

# Chrome Bridge

Use `chrome-bridge` as the only agent interface. It prints JSON on stdout, talks to the installed MV3 extension through Chrome Native Messaging, and never opens a server port.

## Start with the target tab

Run:

```bash
chrome-bridge status
chrome-bridge list-tabs
```

Pass `--tab=ID` whenever more than one useful tab exists. The loaded extension grants the CLI direct access without pairing, tab authorization, capability switches, approval prompts, or output redaction.

The extension toolbar icon opens a live, status-only panel showing the bridge connection, debugger attachments, active captures, request counts, and the latest 25 commands by tab title. Expand one command at a time to inspect nested request and response key/value rows; large values are paged without changing the complete disk-backed data, and the copy action copies both sides as formatted JSON. The panel observes CLI activity but never gates it.

Target an ordinary `http://` or `https://` tab. Chrome blocks debugger attachment to internal `chrome://` pages. Close that tab's DevTools before using debugger-backed commands because Chrome permits only one debugger client per target.

## Preserve complete results

Write large outputs to disk instead of flooding the agent context:

```bash
chrome-bridge dom --tab=3 --file=/tmp/page-dom.json
chrome-bridge network capture --tab=3 --duration=15s --bodies --file=/tmp/network.json
chrome-bridge page mhtml --tab=3 --file=/tmp/page.mhtml
chrome-bridge performance trace --tab=3 --duration=10s --file=/tmp/trace.json
```

Inspect those files with normal shell tools. Native messages are chunked and reassembled without a total bridge payload cap; do not mistake terminal or agent-context clipping for CLI truncation.

## Inspect a page

```bash
chrome-bridge snapshot --tab=3
chrome-bridge dom --tab=3
chrome-bridge dom snapshot --tab=3
chrome-bridge visible-text --tab=3
chrome-bridge styles --tab=3 --selector='.target'
chrome-bridge targets --tab=3
chrome-bridge screenshot --tab=3 --file=/tmp/page.png
chrome-bridge screenshot --tab=3 --selector='.target' --file=/tmp/element.png
chrome-bridge screencast --tab=3 --duration=5s --file=/tmp/frames.json
```

Use `snapshot` for semantic element grounding, `dom` for serialized page code, `dom snapshot` for CDP layout/paint data, and `styles` for matched and computed CSS.

## Discover APIs and live traffic

For a timed observation:

```bash
chrome-bridge network capture --tab=3 --duration=15s --url-filter='/api/'
chrome-bridge network capture --tab=3 --duration=15s --bodies
chrome-bridge network export-har --tab=3 --duration=15s > trace.har
```

For a user action or multi-step flow, start first, perform or request the action, then stop:

```bash
chrome-bridge network start --tab=3 --bodies
chrome-bridge network tail --tab=3 --session=SESSION_ID
chrome-bridge network get-body --tab=3 --session=SESSION_ID --request=REQUEST_KEY
chrome-bridge network stop --tab=3 --session=SESSION_ID
```

Captures include request payloads, initiators, timing, response metadata, optional complete bodies, WebSocket frames, and recursively attached iframe/worker targets. `network start` stays attached until `network stop`; timed captures run for the requested duration.

## Read runtime, source, and storage data

```bash
chrome-bridge console capture --tab=3 --duration=5s
chrome-bridge scripts list --tab=3
chrome-bridge scripts get --tab=3 --url='main.js'
chrome-bridge resources tree --tab=3
chrome-bridge resources get --tab=3 --frame=FRAME_ID --url='https://example.com/app.js'
chrome-bridge page mhtml --tab=3 --file=/tmp/page.mhtml
chrome-bridge storage --tab=3
chrome-bridge storage --tab=3 --bodies
chrome-bridge cookies --tab=3
```

`storage` reads local storage, session storage, IndexedDB records, and Cache API entries from the page origin. Use the resource tree IDs when fetching a resource body.

## Profile and use CDP directly

```bash
chrome-bridge performance metrics --tab=3
chrome-bridge performance profile --tab=3 --duration=5s
chrome-bridge performance trace --tab=3 --duration=10s --file=/tmp/trace.json
chrome-bridge cdp send --tab=3 --method=Runtime.evaluate --params='{"expression":"1+1"}'
chrome-bridge cdp send --tab=3 --session-id=CHILD_SESSION --method=Runtime.getHeapUsage
chrome-bridge cdp events --tab=3 --domain=Network --duration=10s
```

Use a persistent session when several CDP commands depend on prior state:

```bash
chrome-bridge cdp session-start --tab=3
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.enable
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.setBreakpointByUrl --params='{"lineNumber":10,"url":"https://example.com/app.js"}'
chrome-bridge cdp events --bridge-session=SESSION --domain=Debugger --duration=30s
chrome-bridge cdp session-stop --bridge-session=SESSION
```

Run `targets` without `--tab` to list page, iframe, worker, and extension targets, then replace `--tab=ID` with `--target=TARGET_ID` for raw CDP commands or persistent sessions. `--session-id=CHILD_SESSION` routes through a flat child target. Chrome Bridge forwards every syntactically valid method; Chrome itself rejects domains unavailable to the MV3 `chrome.debugger` API.

## Operate only when requested

```bash
chrome-bridge eval --tab=3 'document.title'
chrome-bridge click --tab=3 --selector='button.submit'
chrome-bridge click --tab=3 --x=240 --y=180
chrome-bridge hover --tab=3 --selector='.menu'
chrome-bridge drag --tab=3 --from-selector='.card' --to-selector='.column'
chrome-bridge type --tab=3 --selector='input[name=q]' --text='query'
chrome-bridge type-text --tab=3 --text='text for the focused element'
chrome-bridge press-key --tab=3 'Meta+A'
chrome-bridge fill-form --tab=3 --elements='[{"selector":"#email","value":"me@example.com"}]'
chrome-bridge upload-file --tab=3 --selector='input[type=file]' --file=/tmp/example.png
chrome-bridge wait-for --tab=3 --selector='.loaded' --duration=30s
chrome-bridge handle-dialog --tab=3 --action=accept --prompt-text='value'
chrome-bridge resize --tab=3 --width=1280 --height=720
chrome-bridge emulate --tab=3 --viewport=390x844x3 --mobile --cpu=4
chrome-bridge emulate --tab=3 --latency=100 --download=200000 --upload=100000
chrome-bridge emulate --tab=3 --clear
chrome-bridge navigate --tab=3 --url='https://example.com'
chrome-bridge new-tab 'https://example.com'
chrome-bridge close-tab --tab=3
chrome-bridge reload --tab=3
```

Inspection, interaction, navigation, and side-effecting evaluation all run directly through the CLI.

Browser-wide metadata is available with `history search`, `bookmarks tree`, `bookmarks search`, and `downloads search`. Use `extensions list` and `extension reload --extension=ID` while developing other unpacked extensions. Use `chrome call --api=NAMESPACE --method=METHOD --args='[...]'` as the raw escape hatch for any granted Chrome Extension API, for example `chrome call --api=windows --method=getAll --args='[{"populate":true}]'`.

Large native-messaging payloads are chunked without truncation. Use `chrome-bridge audit` to inspect the local command log and `chrome-bridge detach --tab=ID` to end every attachment to a tab immediately.

After changing the unpacked extension's manifest or service-worker code, reload Chrome Bridge at `chrome://extensions` before live testing. If a command reports that another debugger is attached, close DevTools or run `chrome-bridge detach --tab=ID`, then retry.
