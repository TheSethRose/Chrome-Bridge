# Chrome Bridge

Chrome Bridge gives local coding agents a JSON CLI for inspecting and operating tabs in your normal signed-in Chrome profile. It uses a Manifest V3 extension, `chrome.debugger`, and Chrome Native Messaging; there is no MCP server, HTTP server, WebSocket, remote code, or telemetry.

## Install

```bash
cd ~/Developer/experiments/chrome-bridge
npm run setup
```

Then load `~/Developer/experiments/chrome-bridge/extension` through `chrome://extensions` using **Developer mode** and **Load unpacked**. The extension connects automatically and the CLI can immediately access normal tabs. Click its toolbar icon to open the live status panel; it reports the native connection, debugger attachments, network captures, request counts, and the latest 25 CLI commands without controlling access. Expand a command to inspect its request and response as nested key/value rows, or use its copy button to copy both as formatted JSON. Large strings and collections are paged in the panel while the complete payload remains available on disk and through copy.

Setup registers the native host, links `chrome-bridge` into `~/.local/bin`, and links the bundled `chrome-bridge`, `x-chrome-bridge`, and `linkedin-chrome-bridge` skills into `~/.agents/skills`. If `~/.local/bin` is not already on `PATH`, setup prints the one line to add.

## Containers and remote agents

Chrome Bridge has no network port to expose. A container running on the same machine as Chrome can use the existing filesystem queue by mounting the host runtime read/write and setting `CHROME_BRIDGE_HOME` to the container path. It also needs Node.js 20 or newer and access to this repository, which can remain read-only:

```yaml
services:
  agent:
    environment:
      CHROME_BRIDGE_HOME: /chrome-bridge-runtime
    volumes:
      - "${HOME}/Library/Application Support/chrome-bridge:/chrome-bridge-runtime"
      - "${HOME}/Developer/experiments/chrome-bridge:/opt/chrome-bridge:ro"
```

The agent can then run `node /opt/chrome-bridge/bin/chrome-bridge.mjs status`. The example uses the default macOS runtime; Linux and override locations are listed in the [data and state guide](skill/chrome-bridge/references/data-and-state.md#where-data-lives).

For a container on another Tailscale machine, keep the runtime on the browser machine and execute the installed CLI there through Tailscale SSH:

```bash
tailscale ssh user@browser-host /absolute/path/to/chrome-bridge list-tabs
```

Do not share the runtime directory over the network or publish it through a generic file server. Write access to that directory grants full Chrome Bridge access to the signed-in browser, including cookies and storage, so mount it only into trusted containers and use Tailscale SSH policy as the remote access boundary.

`upload-file` paths are resolved by Chrome on the browser machine. A container must place uploads in a host-visible directory and pass the host path; a remote agent must copy the file to the browser machine first. Result paths passed through Tailscale SSH are also paths on the browser machine.

## Examples

```bash
chrome-bridge snapshot --help
chrome-bridge commands --json
chrome-bridge doctor
chrome-bridge list-tabs
chrome-bridge tab name --tab=3 --name=research
chrome-bridge capabilities --tab=research
chrome-bridge new-tab 'https://example.com'
chrome-bridge locate --tab=research --role=button --name='Save changes'
chrome-bridge dom --tab=research --selector=main --fields=url,html --compact
chrome-bridge visible-text --tab=3
chrome-bridge eval --tab=3 'document.title'
chrome-bridge network capture --tab=3 --duration=10s --url-filter='/api/'
chrome-bridge network capture --tab=3 --reload --wait=network-idle --bodies
chrome-bridge console capture --tab=3 --duration=5s
chrome-bridge scripts list --tab=3
chrome-bridge screenshot --tab=3 --file=page.png
chrome-bridge click --tab=3 --backend-node-id=456 --wait-for-selector=main
chrome-bridge watch --tab=3 --request='*/graphql' --duration=30s
chrome-bridge press-key --tab=3 'Meta+A'
chrome-bridge emulate --tab=3 --viewport=390x844x3 --mobile --cpu=4 --ttl=10m
chrome-bridge cdp session-start --tab=3 --ttl=5m
chrome-bridge cdp send --tab=3 --method=Runtime.evaluate --params='{"expression":"1+1"}'
chrome-bridge chrome call --api=windows --method=getAll --args='[{"populate":true}]'
```

The CLI has direct access to page data, browser data, real CDP mouse and keyboard input, dialogs, file upload, emulation, screencasts, evaluation, extension management, stateful debugger sessions, child targets, and every CDP method Chrome exposes to extensions. `chrome call` is the raw escape hatch for granted Chrome Extension APIs. Raw output can be shaped with `--fields`, `--jq`, `--max-results`, `--compact`, and `--ndjson`; saved files return a hash-bearing artifact receipt. Large requests and responses are chunked across native-messaging frames, so Chrome's per-message limits do not truncate the result.

Chrome intentionally withholds some CDP domains from `chrome.debugger`, including browser-process and heap-profiler surfaces. No MV3 extension can bypass that platform boundary inside a normal Chrome profile; those commands require Chrome's separate remote-debugging connection and its browser-level consent. Chrome Bridge forwards any syntactically valid CDP method and reports Chrome's own error when the browser does not permit it.

## Validate

```bash
npm run verify
```

The automated check covers the manifest, live status panel, chunked native-message transport, argument parsing, and command contracts. A live browser smoke test still requires loading the unpacked extension.
