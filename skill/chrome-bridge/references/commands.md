# Command reference

All commands print JSON. Add `--timeout=30s` to bound CLI waiting and `--file=/absolute/path` to write a complete result instead of printing it. Durations accept `ms`, `s`, or `m`.

## Tabs and navigation

```text
status
list-tabs
new-tab [URL] [--active=false]
close-tab --tab=ID
activate-tab --tab=ID
navigate --tab=ID --url=URL
reload --tab=ID
go-back --tab=ID
go-forward --tab=ID
detach --tab=ID
```

`detach` stops every debugger owner on that tab, including captures, emulation, and persistent sessions.

## Page inspection

```text
snapshot --tab=ID [--depth=N]
dom --tab=ID
dom snapshot --tab=ID [--styles=CSV] [--paint-order=false] [--dom-rects=false]
visible-text --tab=ID
styles --tab=ID --selector=CSS
screenshot --tab=ID [--selector=CSS] [--format=png|jpeg] [--quality=N] [--file=PATH]
screencast --tab=ID [--duration=5s] [--format=jpeg|png] [--quality=N] [--width=N] [--height=N] [--every-nth-frame=N] [--file=PATH]
eval --tab=ID [--eval-timeout=5s] JAVASCRIPT
```

`snapshot` returns the accessibility tree. `dom` returns page HTML. `screencast` returns CDP frames as JSON rather than transcoding them into a video.

## Input and page control

```text
click --tab=ID (--selector=CSS | --x=N --y=N) [--double]
hover --tab=ID (--selector=CSS | --x=N --y=N)
drag --tab=ID (--from-selector=CSS --to-selector=CSS | --from-x=N --from-y=N --to-x=N --to-y=N)
type --tab=ID --selector=CSS --text=TEXT
type-text --tab=ID --text=TEXT
press-key --tab=ID KEY_OR_COMBINATION
fill-form --tab=ID --elements='[{"selector":"#email","value":"me@example.com"}]'
upload-file --tab=ID --selector=CSS (--file=PATH | --files='["PATH1","PATH2"]')
wait-for --tab=ID (--selector=CSS | --text=TEXT | --expression=JAVASCRIPT) [--duration=30s]
handle-dialog --tab=ID --action=accept|dismiss [--prompt-text=TEXT]
resize --tab=ID --width=N --height=N [--device-scale-factor=N] [--mobile]
```

`type` focuses and replaces a specific editable element. `type-text` inserts into the element that is already focused. `press-key` accepts combinations such as `Meta+A`, `Control+Shift+R`, `Enter`, or `Escape`. `resize` uses persistent device emulation, so clear it with `emulate --clear` when finished.

## Emulation

```text
emulate --tab=ID [--viewport=WIDTHxHEIGHTxDPR] [--mobile]
  [--cpu=RATE] [--latitude=N --longitude=N --accuracy=N]
  [--user-agent=TEXT] [--color-scheme=dark|light|auto]
  [--headers='{"X-Header":"value"}']
  [--offline] [--latency=MS] [--download=BYTES_PER_SECOND] [--upload=BYTES_PER_SECOND]
emulate --tab=ID --clear
```

Emulation stays attached and persists until `--clear` or `detach`.

## Network and console

```text
network capture --tab=ID [--duration=10s] [--url-filter=TEXT] [--bodies]
network start --tab=ID [--url-filter=TEXT] [--bodies] [--max-duration=1m]
network tail --tab=ID [--session=ID]
network get-body --tab=ID [--session=ID] --request=REQUEST_KEY
network stop --tab=ID [--session=ID] [--har]
network export-har --tab=ID [--duration=10s] [--bodies]
console capture --tab=ID [--duration=5s]
```

Fetch a body before stopping its capture. Use `--bodies` when the final capture result must retain response bodies.

## Source, storage, and page resources

```text
scripts list --tab=ID
scripts get --tab=ID --url=TEXT
resources tree --tab=ID
resources get --tab=ID --frame=FRAME_ID --url=RESOURCE_URL
page mhtml --tab=ID [--file=PATH]
cookies --tab=ID
storage --tab=ID [--bodies]
targets [--tab=ID]
```

`storage` returns local and session storage, IndexedDB, and Cache API data. `targets` without a tab returns Chrome's complete debugger-target inventory; with a tab it also returns that page's frame tree.

## Performance

```text
performance metrics --tab=ID
performance profile --tab=ID [--duration=5s] [--interval=MICROSECONDS]
performance trace --tab=ID [--duration=5s] [--categories=CSV] [--trace-config=JSON] [--file=PATH]
```

## Browser-wide and extension APIs

```text
history search [--query=TEXT] [--start-time=EPOCH_MS] [--limit=N]
bookmarks tree
bookmarks search [--query=TEXT]
downloads search [--query=TEXT] [--limit=N]
extensions list
extension reload --extension=ID
audit
chrome call --api=NAMESPACE --method=METHOD --args='[ARG1,ARG2]'
```

`chrome call` invokes any callable Chrome Extension API available under the permissions granted in the manifest. Arguments must be a JSON array. Chrome Bridge cannot reload itself through `extension reload`; reload it from `chrome://extensions`.

## Raw CDP

```text
cdp send (--tab=ID | --target=TARGET_ID | --bridge-session=SESSION)
  --method=Domain.command [--params=JSON] [--session-id=CHILD_SESSION]
cdp events (--tab=ID | --target=TARGET_ID | --bridge-session=SESSION)
  --domain=Domain [--enable-params=JSON] [--duration=5s]
cdp session-start (--tab=ID | --target=TARGET_ID)
cdp session-stop --bridge-session=SESSION
```

One-shot `cdp send` attaches only for that command. Use a bridge session for domain state that must survive across commands. Chrome's MV3 debugger API intentionally withholds some browser-process and heap-profiler domains; the CLI returns Chrome's own protocol error for those methods.
