# Chrome Bridge

Chrome Bridge gives local coding agents a JSON CLI for inspecting and operating tabs in your normal signed-in Chrome profile. It uses a Manifest V3 extension, `chrome.debugger`, and Chrome Native Messaging; there is no MCP server, HTTP server, WebSocket, remote code, or telemetry.

## Install

```bash
cd ~/Developer/experiments/chrome-bridge
npm run setup
```

Then load `~/Developer/experiments/chrome-bridge/extension` through `chrome://extensions` using **Developer mode** and **Load unpacked**. The extension connects automatically and the CLI can immediately access normal tabs. Click its toolbar icon to open the live status panel; it reports the native connection, debugger attachments, network captures, request counts, and the latest 25 CLI commands without controlling access. Expand a command to inspect its request and response as nested key/value rows, or use its copy button to copy both as formatted JSON. Large strings and collections are paged in the panel while the complete payload remains available on disk and through copy.

Setup registers the native host, links `chrome-bridge` into `~/.local/bin`, and links the bundled `chrome-bridge`, `x-chrome-bridge`, and `linkedin-chrome-bridge` skills into `~/.agents/skills`. If `~/.local/bin` is not already on `PATH`, setup prints the one line to add.

## Examples

```bash
chrome-bridge list-tabs
chrome-bridge new-tab 'https://example.com'
chrome-bridge dom --tab=3
chrome-bridge visible-text --tab=3
chrome-bridge eval --tab=3 'document.title'
chrome-bridge network capture --tab=3 --duration=10s --url-filter='/api/'
chrome-bridge network capture --tab=3 --duration=10s --bodies
chrome-bridge console capture --tab=3 --duration=5s
chrome-bridge scripts list --tab=3
chrome-bridge screenshot --tab=3 --file=page.png
chrome-bridge click --tab=3 --selector='button'
chrome-bridge press-key --tab=3 'Meta+A'
chrome-bridge emulate --tab=3 --viewport=390x844x3 --mobile --cpu=4
chrome-bridge cdp session-start --tab=3
chrome-bridge cdp send --tab=3 --method=Runtime.evaluate --params='{"expression":"1+1"}'
chrome-bridge chrome call --api=windows --method=getAll --args='[{"populate":true}]'
```

The CLI has direct access to page data, browser data, real CDP mouse and keyboard input, dialogs, file upload, emulation, screencasts, evaluation, extension management, stateful debugger sessions, child targets, and every CDP method Chrome exposes to extensions. `chrome call` is the raw escape hatch for granted Chrome Extension APIs. Output is returned unchanged. Large requests and responses are chunked across native-messaging frames, so Chrome's per-message limits do not truncate the result.

Chrome intentionally withholds some CDP domains from `chrome.debugger`, including browser-process and heap-profiler surfaces. No MV3 extension can bypass that platform boundary inside a normal Chrome profile; those commands require Chrome's separate remote-debugging connection and its browser-level consent. Chrome Bridge forwards any syntactically valid CDP method and reports Chrome's own error when the browser does not permit it.

## Validate

```bash
npm run verify
```

The automated check covers the manifest, live status panel, chunked native-message transport, argument parsing, and command contracts. A live browser smoke test still requires loading the unpacked extension.
