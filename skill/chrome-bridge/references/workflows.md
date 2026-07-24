# Workflow recipes

Use these combinations when one command is insufficient. Replace IDs and selectors with values discovered from the live page. Read [commands.md](commands.md) for each command's purpose and result, and [data-and-state.md](data-and-state.md) when the recipe produces IDs, captures, retained logs, or large files.

## Inspect, act, and verify

```bash
chrome-bridge capabilities --tab=3
chrome-bridge snapshot --tab=3 --compact --file=/tmp/before.json
chrome-bridge click --tab=3 --role=button --name='Save changes' --wait-role=status --wait-name=Saved --wait-timeout=15s
chrome-bridge snapshot --tab=3 --compact --file=/tmp/after.json
chrome-bridge snapshot diff --before=/tmp/before.json --after=/tmp/after.json --compact
```

Semantic actions resolve and act in one debugger attachment. Zero matches return nearby candidates; multiple matches fail until `--exact`, `--within`, or zero-based `--nth` identifies one. Verify an external action from a semantic status, cleared composer, changed URL, resulting DOM, or captured request.

## Extract repeated records

```bash
chrome-bridge extract --tab=3 --within=main --item='article' \
  --schema='{"author":{"selector":"[data-testid=User-Name]","property":"innerText"},"text":{"selector":"[data-testid=tweetText]","property":"innerText"},"url":{"selector":"time","closest":"a","property":"href"}}' \
  --file=/tmp/articles.json
```

Use one item selector and a field schema instead of custom `eval` for repeated cards, rows, links, or search results. Results default to 100 records and never exceed 1,000 in one command.

## Discover a private API during a real action

```bash
chrome-bridge network start --tab=3 --bodies --url-filter='/api/' --ttl=5m
chrome-bridge click --tab=3 --selector='button.save' --wait-for-selector='.saved' --wait-timeout=15s
chrome-bridge network tail --tab=3 --session=SESSION --errors-only
chrome-bridge network get-body --tab=3 --session=SESSION --request=REQUEST_KEY --pretty
chrome-bridge network stop --tab=3 --session=SESSION --file=/tmp/save-flow.json
```

Start the capture before the triggering action. Inspect request method, URL, headers, payload, initiator, status, and body together before implementing against the private endpoint.

## Investigate an initial page load

```bash
chrome-bridge network capture --tab=3 --reload --wait=network-idle --duration=30s --bodies --file=/tmp/page-load.json
chrome-bridge console capture --tab=3 --duration=2s --file=/tmp/console.json
```

Use a fresh capture because CDP only observes events after attachment.

## Inspect source behind a runtime element

```bash
chrome-bridge styles --tab=3 --selector='.target'
chrome-bridge scripts list --tab=3
chrome-bridge scripts get --tab=3 --url='app.js' --file=/tmp/app-source.json
chrome-bridge resources tree --tab=3 --file=/tmp/resources.json
```

Use `styles` for the element's computed and matched CSS. Use script and resource commands for original responses; use raw `Debugger` commands when setting breakpoints or inspecting paused state.

## Debug with a persistent CDP session

```bash
chrome-bridge cdp session-start --tab=3 --ttl=5m
chrome-bridge cdp send --bridge-session=SESSION --method=Runtime.enable
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.enable
chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.setPauseOnExceptions --params='{"state":"all"}'
chrome-bridge cdp events --bridge-session=SESSION --domain=Debugger --duration=30s --file=/tmp/debugger-events.json
chrome-bridge cdp session-stop --bridge-session=SESSION
```

Keep the session ID separate from a network capture session and a CDP child `session-id`; they route different layers.

## Inspect an iframe, worker, or extension service worker

```bash
chrome-bridge targets --file=/tmp/targets.json
chrome-bridge cdp session-start --target=TARGET_ID --ttl=5m
chrome-bridge cdp send --bridge-session=SESSION --method=Runtime.enable
chrome-bridge cdp send --bridge-session=SESSION --method=Runtime.evaluate --params='{"expression":"self.location.href","returnByValue":true}'
chrome-bridge cdp session-stop --bridge-session=SESSION
```

For a child discovered through `Target.attachedToTarget`, keep the tab or root target and pass its CDP `--session-id=CHILD_SESSION` to `cdp send`.

## Reproduce mobile, slow-network, or dark-mode behavior

```bash
chrome-bridge emulate --tab=3 --viewport=390x844x3 --mobile --cpu=4 --latency=100 --download=200000 --upload=100000 --color-scheme=dark --ttl=10m
chrome-bridge reload --tab=3 --wait=load --wait-timeout=30s
chrome-bridge screenshot --tab=3 --file=/tmp/mobile-dark.png
chrome-bridge emulate --tab=3 --clear
```

Always clear emulation after the check. Use `detach` if a failed command leaves the debugger attached.

## Record performance evidence

```bash
chrome-bridge performance metrics --tab=3 --file=/tmp/metrics.json
chrome-bridge performance profile --tab=3 --duration=10s --file=/tmp/cpu-profile.json
chrome-bridge performance trace --tab=3 --duration=10s --file=/tmp/trace.json
```

The bridge returns raw evidence. Analyze Core Web Vitals or trace insights from the saved trace rather than asking the CLI to summarize them.

## Develop another unpacked extension

```bash
chrome-bridge extensions list --file=/tmp/extensions.json
chrome-bridge extension reload --extension=TARGET_EXTENSION_ID
chrome-bridge targets --file=/tmp/targets.json
chrome-bridge cdp send --target=SERVICE_WORKER_TARGET --method=Runtime.evaluate --params='{"expression":"self.location.href","returnByValue":true}'
```

Reload the target extension, rediscover its service-worker target because target IDs can change, then attach to the new target. Chrome Bridge must be reloaded manually when its own service worker or manifest changes.

## Recover from an interrupted task

```bash
chrome-bridge status
chrome-bridge network stop --tab=3 --session=SESSION
chrome-bridge cdp session-stop --bridge-session=SESSION
chrome-bridge emulate --tab=3 --clear
chrome-bridge detach --tab=3
```

Use the targeted stop command when the session ID is known. Use `detach` as the final cleanup for a tab; it ends all debugger-backed activity on that tab.
