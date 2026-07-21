---
name: chrome-bridge
description: Inspect, debug, and fully operate the user's existing signed-in Chrome session through the local chrome-bridge JSON CLI, without MCP or a separate automation profile. Use for live DOM, accessibility, styles, scripts, resources, console, network bodies, WebSockets, storage, cookies, targets, screenshots, screencasts, performance, emulation, dialogs, file upload, real mouse and keyboard input, extension management, browser APIs, JavaScript evaluation, or stateful raw CDP while developing websites and Chrome extensions.
---

# Chrome Bridge

Use `chrome-bridge` as the only interface. It prints JSON, talks to the installed MV3 extension through Native Messaging, and operates the user's normal signed-in Chrome session without MCP or a server port.

## Start from live state

Run:

```bash
chrome-bridge status
chrome-bridge list-tabs
```

Pass `--tab=ID` when more than one useful tab exists. Target ordinary web tabs; Chrome blocks debugger attachment to internal `chrome://` pages. Close a tab's DevTools before attaching because Chrome permits one debugger client per target.

Read [references/commands.md](references/commands.md) when choosing flags or a less common command. Read [references/workflows.md](references/workflows.md) before a multi-command investigation, browser action, extension-debugging task, persistent CDP session, or recovery sequence.

## Use the shortest reliable loop

1. Inspect with `snapshot`, a narrow `eval`, or `visible-text`.
2. Act with a grounded selector and the direct input command.
3. Verify the resulting DOM, page state, URL, toast, or network request.

Prefer narrow queries over dumping the whole page. Use `snapshot` for semantic grounding, `dom` for serialized page code, `dom snapshot` for layout and paint data, and `styles` for matched and computed CSS.

For a simple action:

```bash
chrome-bridge eval --tab=3 '({title:document.title,url:location.href})'
chrome-bridge click --tab=3 --selector='button.submit'
chrome-bridge wait-for --tab=3 --selector='.success' --duration=15s
```

Perform external or destructive actions only when the user requested them. Submit exactly the approved content, then verify success from the page or network response.

## Keep complete data off the agent context

Write large results to files:

```bash
chrome-bridge dom --tab=3 --file=/tmp/page-dom.json
chrome-bridge network capture --tab=3 --duration=15s --bodies --file=/tmp/network.json
chrome-bridge page mhtml --tab=3 --file=/tmp/page.mhtml
chrome-bridge performance trace --tab=3 --duration=10s --file=/tmp/trace.json
```

Native messages are chunked and reassembled without a total bridge payload cap. Terminal or agent-context clipping is not CLI truncation.

## Capture a user flow

Start before the action and stop after it:

```bash
chrome-bridge network start --tab=3 --bodies
chrome-bridge network tail --tab=3 --session=SESSION_ID
chrome-bridge network get-body --tab=3 --session=SESSION_ID --request=REQUEST_KEY
chrome-bridge network stop --tab=3 --session=SESSION_ID --file=/tmp/network.json
```

Captures include request payloads, initiators, timing, response metadata, optional complete bodies, WebSocket frames, and attached iframe or worker targets.

## Keep CDP state across commands

Use a persistent session when commands depend on an enabled domain, breakpoint, interception rule, emulation state, or child target:

```bash
chrome-bridge cdp session-start --tab=3
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.enable
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.setBreakpointByUrl --params='{"lineNumber":10,"url":"https://example.com/app.js"}'
chrome-bridge cdp events --bridge-session=SESSION --domain=Debugger --duration=30s
chrome-bridge cdp session-stop --bridge-session=SESSION
```

Run `targets` without `--tab` to discover page, iframe, worker, and extension targets. Use `--target=TARGET_ID` for a root target and `--session-id=CHILD_SESSION` for a flat child session. Chrome Bridge forwards every syntactically valid method; Chrome itself rejects domains unavailable to MV3 `chrome.debugger`.

## Leave the browser clean

Stop captures and persistent sessions when finished. Clear persistent emulation with `chrome-bridge emulate --tab=ID --clear`; use `chrome-bridge detach --tab=ID` to end every attachment to a tab immediately.

The toolbar side panel shows live connection state and the last 25 commands. It observes activity but never gates access. After changing Chrome Bridge's manifest or service worker, reload the unpacked extension at `chrome://extensions` before live testing.
