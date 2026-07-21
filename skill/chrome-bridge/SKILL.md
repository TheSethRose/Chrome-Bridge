---
name: chrome-bridge
description: Inspect, debug, and operate the user's existing signed-in Chrome session through the local chrome-bridge JSON CLI, without MCP or a separate automation profile. Use when an agent needs live page DOM, accessibility, styles, scripts, resources, console, network requests or complete bodies, WebSocket frames, storage, cookies, targets, screenshots, performance data, browsing data, JavaScript evaluation, raw CDP access, or page interaction while developing websites and Chrome extensions.
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

Raw CDP accepts every domain Chrome exposes through `chrome.debugger`, including mutating commands and child-session routing.

## Operate only when requested

```bash
chrome-bridge eval --tab=3 'document.title'
chrome-bridge click --tab=3 --selector='button.submit'
chrome-bridge type --tab=3 --selector='input[name=q]' --text='query'
chrome-bridge navigate --tab=3 --url='https://example.com'
chrome-bridge reload --tab=3
```

Inspection, interaction, navigation, and side-effecting evaluation all run directly through the CLI.

Browser-wide metadata is available with `history search`, `bookmarks tree`, `bookmarks search`, and `downloads search`. Large native-messaging payloads are chunked without truncation. Use `chrome-bridge audit` to inspect the local command log and `chrome-bridge detach --tab=ID` to end any attachment immediately.

After changing the unpacked extension's manifest or service-worker code, reload Chrome Bridge at `chrome://extensions` before live testing. If a command reports that another debugger is attached, close DevTools or run `chrome-bridge detach --tab=ID`, then retry.
