const arg = (type, description, extra = {}) => ({ type, description, ...extra });

export const COMMON_ARGUMENTS = {
  tab: arg("tab", "Chrome tab ID or saved tab name. Omit only when the active tab is unambiguous."),
  timeout: arg("duration", "Maximum time for the CLI request.", { default: "unbounded" }),
  file: arg("path", "Write the complete result to this path instead of stdout."),
  out: arg("path", "Write the complete result to this path; useful when --file is command input."),
  fields: arg("csv", "Keep these top-level fields in object results."),
  jq: arg("string", "Filter the raw result with the installed jq executable."),
  compact: arg("boolean", "Emit compact JSON.", { default: false }),
  ndjson: arg("boolean", "Emit array items as newline-delimited JSON.", { default: false }),
  maxResults: arg("integer", "Limit top-level result arrays.")
};

const tab = { tab: COMMON_ARGUMENTS.tab };
const duration = { duration: arg("duration", "How long to collect or wait.", { default: "10s" }) };
const fiveSecondDuration = { duration: arg("duration", "How long to collect or wait.", { default: "5s" }) };
const thirtySecondDuration = { duration: arg("duration", "How long to wait.", { default: "30s" }) };
const networkPresentation = {
  graphql: arg("boolean", "Group GraphQL requests by operation name.", { default: false }),
  websockets: arg("boolean", "Return only WebSocket frames.", { default: false }),
  eventStream: arg("boolean", "Return only text/event-stream requests.", { default: false }),
  errorsOnly: arg("boolean", "Return only failed requests or HTTP status 400 and above.", { default: false }),
};
const selector = { selector: arg("string", "CSS selector scoped to the current document.") };
const semanticTarget = {
  role: arg("string", "Match an accessibility role."),
  name: arg("string", "Match an accessible name."),
  text: arg("string", "Match accessible text, value, or description."),
  exact: arg("boolean", "Require an exact case-insensitive name/text match.", { default: false }),
  nth: arg("integer", "Select this zero-based match; omitted means ambiguous matches fail."),
  within: arg("string", "Limit semantic matching to this CSS subtree."),
};
const semanticTypeTarget = {
  role: semanticTarget.role,
  name: semanticTarget.name,
  targetText: arg("string", "Match accessible text, value, or description."),
  exact: semanticTarget.exact,
  nth: semanticTarget.nth,
  within: semanticTarget.within,
};
const wait = {
  wait: arg("enum", "Wait for page load completion.", { enum: ["load"] }),
  waitForUrl: arg("string", "Wait until the tab URL contains this value."),
  waitForSelector: arg("string", "Wait until this CSS selector exists."),
  waitRole: arg("string", "Wait for an accessibility role."),
  waitName: arg("string", "Wait for an accessible name."),
  waitText: arg("string", "Wait for accessible text, value, or description."),
  waitState: arg("enum", "Required semantic state.", { enum: ["attached", "visible", "hidden", "enabled", "disabled"], default: "attached" }),
  waitExact: arg("boolean", "Require an exact semantic wait match.", { default: false }),
  waitNth: arg("integer", "Select this zero-based semantic wait match."),
  waitWithin: arg("string", "Limit the semantic wait to this CSS subtree."),
  waitTimeout: arg("duration", "Maximum action wait.", { default: "30s" }),
};

function command(path, summary, config = {}) {
  const name = path.join(" ");
  const examples = config.examples || [`chrome-bridge ${name}`, `chrome-bridge ${name} --help`];
  return {
    id: config.id || path.join("-"),
    path,
    name,
    aliases: config.aliases || [],
    summary,
    syntax: config.syntax || `chrome-bridge ${name} [options]`,
    changesPageState: Boolean(config.changesPageState),
    pageStateNotes: config.pageStateNotes || (config.changesPageState ? "May change the current page or browser state." : "Does not change page content."),
    requiresExplicitTab: config.requiresExplicitTab ?? Boolean(config.changesPageState),
    debuggerAttachment: config.debuggerAttachment || "none",
    usesCommonArguments: config.usesCommonArguments !== false,
    positionals: config.positionals || [],
    arguments: config.arguments || {},
    requirements: config.requirements || [],
    examples,
    output: config.output || "JSON value returned by Chrome.",
  };
}

export const COMMANDS = [
  command(["help"], "Show global, group, or per-command help without contacting Chrome.", {
    syntax: "chrome-bridge help [COMMAND [SUBCOMMAND]]", usesCommonArguments: false,
    positionals: [{ name: "command", type: "string", required: false, description: "Command or command group to describe." }],
    output: "Command catalog summary, group listing, or complete command help.",
    examples: ["chrome-bridge help snapshot", "chrome-bridge help network capture"],
  }),
  command(["commands"], "Return the machine-readable command schema without contacting Chrome.", {
    syntax: "chrome-bridge commands --json", usesCommonArguments: false,
    arguments: { json: arg("boolean", "Request JSON schema output.", { default: true }) },
    output: "{schemaVersion,commonArguments,commands}",
    examples: ["chrome-bridge commands --json", "chrome-bridge commands --json > /tmp/chrome-bridge-commands.json"],
  }),
  command(["setup"], "Install the CLI link, native-host manifest, and bundled skill links.", {
    syntax: "chrome-bridge setup", usesCommonArguments: false, changesPageState: false,
    output: "{installed,extensionId,loadUnpacked,nativeManifest,cli,skill,bonusSkill,linkedinSkill,pathHint}",
    examples: ["chrome-bridge setup", "npm run setup"],
  }),
  command(["status"], "Show connection, command, debugger, capture, and audit state.", {
    output: "{bridgeOnline,nativeConnected,connectionState,versions,attachedTabs,activeCommands,activeCaptures,cdpSessions,emulatedTabs,activity,recentCommands}",
    examples: ["chrome-bridge status", "chrome-bridge status --file=/tmp/bridge-status.json"],
  }),
  command(["list-tabs"], "List browser tabs and their stable tab IDs.", {
    output: "Array<{id,windowId,active,title,url,attached}>",
    examples: ["chrome-bridge list-tabs", "chrome-bridge list-tabs --file=/tmp/tabs.json"],
  }),
  command(["new-tab"], "Open a new browser tab.", {
    syntax: "chrome-bridge new-tab [URL] [--active=false]",
    changesPageState: true,
    arguments: { url: arg("url", "URL to open.", { default: "about:blank" }), active: arg("boolean", "Whether to activate the new tab.", { default: true }) },
    output: "Chrome Tab object.",
    examples: ["chrome-bridge new-tab https://example.com", "chrome-bridge new-tab --url=about:blank --active=false"],
  }),
  command(["close-tab"], "Close a tab.", {
    syntax: "chrome-bridge close-tab --tab=ID",
    changesPageState: true,
    arguments: tab,
    requirements: ["tab"],
    output: "{closed:true,tabId}",
    examples: ["chrome-bridge close-tab --tab=123", "chrome-bridge close-tab --tab=123 --timeout=10s"],
  }),
  command(["activate-tab"], "Make a tab active.", {
    syntax: "chrome-bridge activate-tab --tab=ID",
    changesPageState: true,
    arguments: tab,
    requirements: ["tab"],
    output: "Chrome Tab object.",
    examples: ["chrome-bridge activate-tab --tab=123", "chrome-bridge activate-tab --tab=456"],
  }),
  command(["tab", "name"], "Assign a stable local name to a tab.", {
    id: "tab-name", requiresExplicitTab: true, arguments: { ...tab, name: arg("string", "Unique tab name.", { required: true }) }, requirements: ["tab", "name"],
    output: "{name,tabId,url,title}", examples: ["chrome-bridge tab name --tab=123 --name=linkedin-profile", "chrome-bridge snapshot --tab=linkedin-profile --compact"],
  }),
  command(["navigate"], "Navigate an existing tab and optionally wait for readiness.", {
    syntax: "chrome-bridge navigate --tab=ID --url=URL [--wait=load]",
    changesPageState: true,
    arguments: { ...tab, url: arg("url", "Destination URL.", { required: true }), ...wait },
    requirements: ["url"],
    output: "Chrome Tab fields plus {wait?,finalUrl,title}.",
    examples: ["chrome-bridge navigate --tab=123 --url=https://example.com --wait=load", "chrome-bridge navigate --tab=123 --url=https://example.com/app --wait-for-selector=main"],
  }),
  command(["reload"], "Reload a tab.", {
    changesPageState: true, arguments: { ...tab, ...wait }, output: "{reloaded:true,tabId,wait?,finalUrl,title}",
    examples: ["chrome-bridge reload --tab=123 --wait=load", "chrome-bridge reload --tab=123 --wait-for-selector=main"],
  }),
  command(["go-back"], "Move backward in tab history.", {
    changesPageState: true, arguments: { ...tab, ...wait }, output: "{navigated:'back',tabId,wait?,finalUrl,title}",
    examples: ["chrome-bridge go-back --tab=123 --wait=load", "chrome-bridge go-back --tab=123 --wait-for-url=example.com"],
  }),
  command(["go-forward"], "Move forward in tab history.", {
    changesPageState: true, arguments: { ...tab, ...wait }, output: "{navigated:'forward',tabId,wait?,finalUrl,title}",
    examples: ["chrome-bridge go-forward --tab=123 --wait=load", "chrome-bridge go-forward --tab=123 --wait-for-selector=main"],
  }),
  command(["detach"], "Release every Chrome Bridge debugger owner for a tab.", {
    requiresExplicitTab: true, arguments: tab, output: "{detached:true,tabId}",
    examples: ["chrome-bridge detach --tab=123", "chrome-bridge status"],
  }),
  command(["inspectability"], "Explain whether Chrome permits inspection of the current tab.", {
    arguments: tab, output: "{tabId,url,scheme,inspectable,owningExtensionId,reason,httpPageWouldBeInspectable,backTargetKnown,goingBackWouldRestoreAccess,debugger}",
    examples: ["chrome-bridge inspectability --tab=123", "chrome-bridge inspectability"],
  }),
  command(["capabilities"], "Report which Chrome Bridge operations the current page supports.", {
    arguments: tab, output: "{tabId,url,scheme,pageType,capabilities,reasons}",
    examples: ["chrome-bridge capabilities --tab=123", "chrome-bridge capabilities"],
  }),
  command(["doctor"], "Check installed versions, permissions, connection, tab access, and a harmless CDP evaluation.", {
    debuggerAttachment: "temporary-when-inspectable", arguments: { ...tab, timeout: arg("duration", "Maximum bridge diagnostic wait.", { default: "5s" }) },
    output: "{ok,versions,checks,inspectability}",
    examples: ["chrome-bridge doctor --tab=123", "chrome-bridge doctor"],
  }),
  command(["audit"], "Read and filter the retained command audit.", {
    arguments: {
      status: arg("enum", "Filter by command status.", { enum: ["ok", "error"] }),
      command: arg("string", "Filter by normalized command ID."),
      since: arg("duration", "Only include commands this recent, such as 1h."),
      summary: arg("boolean", "Return counts instead of individual entries.", { default: false }),
    },
    output: "Array<AuditEntry> or {total,byStatus,byCommand}.",
    examples: ["chrome-bridge audit --status=error --since=1h", "chrome-bridge audit --command=click --summary"],
  }),

  command(["snapshot"], "Read the accessibility tree with optional server-side filtering.", {
    debuggerAttachment: "temporary", arguments: {
      ...tab, ...selector,
      depth: arg("integer", "Maximum accessibility-tree depth."),
      role: arg("string", "Only include nodes whose role contains this value."),
      name: arg("string", "Only include nodes whose accessible name contains this value."),
      maxNodes: arg("integer", "Maximum nodes returned."),
      compact: arg("boolean", "Return only interaction-relevant node fields.", { default: false }),
    },
    output: "{nodes:Array<AXNode>,total,returned,limited,compact}.",
    examples: ["chrome-bridge snapshot --tab=123 --role=button --compact --max-nodes=100", "chrome-bridge snapshot --tab=123 --selector=main --name='Show results'"],
  }),
  command(["snapshot", "diff"], "Compare two saved snapshot JSON artifacts without contacting Chrome.", {
    id: "snapshot-diff", arguments: { before: arg("path", "Earlier snapshot JSON file.", { required: true }), after: arg("path", "Later snapshot JSON file.", { required: true }) },
    requirements: ["before", "after"], output: "{counts:{added,removed,changed},added,removed,changed}",
    examples: ["chrome-bridge snapshot diff --before=/tmp/before.json --after=/tmp/after.json", "chrome-bridge snapshot diff --before=/tmp/before.json --after=/tmp/after.json --max-results=100"],
  }),
  command(["locate"], "Find semantic elements and suggest stable selectors.", {
    debuggerAttachment: "temporary", arguments: { ...tab, ...semanticTarget },
    requirements: ["text, role, or name"], output: "{matches:Array<{backendNodeId,role,name,selector,visible,enabled,selectorStable,generated}>}",
    examples: ["chrome-bridge locate --tab=123 --text='Save changes'", "chrome-bridge locate --tab=123 --role=button --name=Post --max-results=20"],
  }),
  command(["watch"], "Wait for one URL, selector, request, or console condition without shell polling.", {
    debuggerAttachment: "depends-on-condition", arguments: { ...tab, urlChanges: arg("boolean", "Return when the tab URL changes.", { default: false }), selector: arg("string", "Return when this selector appears."), request: arg("string", "Return when a request URL matches this glob."), console: arg("enum", "Collect matching console events.", { enum: ["error", "warning", "all"] }), ...thirtySecondDuration },
    requirements: ["exactly one of urlChanges, selector, request, or console"], output: "{matched,events,elapsedMs}",
    examples: ["chrome-bridge watch --tab=123 --selector='.toast' --duration=30s", "chrome-bridge watch --tab=123 --request='*/graphql' --duration=30s"],
  }),
  command(["dom"], "Serialize live DOM markup, optionally below one element.", {
    debuggerAttachment: "temporary", arguments: { ...tab, ...selector }, output: "{html,url,selector?}",
    examples: ["chrome-bridge dom --tab=123 --selector=main", "chrome-bridge dom --tab=123 --file=/tmp/page.json"],
  }),
  command(["dom", "snapshot"], "Capture DOM layout, paint, and computed-style data.", {
    id: "dom-snapshot", debuggerAttachment: "temporary", arguments: {
      ...tab, styles: arg("csv", "Computed CSS properties to capture."), paintOrder: arg("boolean", "Include paint order.", { default: true }),
      domRects: arg("boolean", "Include DOM rectangles.", { default: true }), blendedColors: arg("boolean", "Include blended background colors.", { default: false }),
      textOpacities: arg("boolean", "Include text color opacities.", { default: false }),
    },
    output: "CDP DOMSnapshot.captureSnapshot result.",
    examples: ["chrome-bridge dom snapshot --tab=123", "chrome-bridge dom snapshot --tab=123 --styles=display,color --paint-order=false"],
  }),
  command(["visible-text"], "Return visible text, optionally below one element.", {
    debuggerAttachment: "temporary", arguments: { ...tab, ...selector }, output: "{text,selector?}",
    examples: ["chrome-bridge visible-text --tab=123 --selector=article", "chrome-bridge visible-text --tab=123"],
  }),
  command(["styles"], "Inspect computed and matched styles for an element.", {
    debuggerAttachment: "temporary", arguments: { ...tab, selector: arg("string", "CSS selector.", { required: true }) }, requirements: ["selector"], output: "{nodeId,attributes,computed,matched}",
    examples: ["chrome-bridge styles --tab=123 --selector='main'", "chrome-bridge styles --tab=123 --selector='.card' --file=/tmp/styles.json"],
  }),
  command(["screenshot"], "Capture a page or element image.", {
    debuggerAttachment: "temporary", arguments: { ...tab, ...selector, ...semanticTarget, format: arg("enum", "Image format.", { enum: ["png", "jpeg"], default: "png" }), quality: arg("integer", "JPEG quality from 1 to 100.", { default: 85 }), fullPage: arg("boolean", "Capture beyond the viewport.", { default: true }) },
    output: "{data,format,tabId}; --file writes image bytes.", examples: ["chrome-bridge screenshot --tab=123 --file=/tmp/page.png", "chrome-bridge screenshot --tab=123 --selector=main --format=jpeg --quality=80 --file=/tmp/main.jpg"],
  }),
  command(["screencast"], "Capture rendered frames for a fixed duration.", {
    debuggerAttachment: "temporary", arguments: { ...tab, ...fiveSecondDuration, format: arg("enum", "Frame format.", { enum: ["png", "jpeg"], default: "jpeg" }), quality: arg("integer", "Frame quality.", { default: 80 }), width: arg("integer", "Maximum frame width."), height: arg("integer", "Maximum frame height."), everyNthFrame: arg("integer", "Capture every Nth frame.", { default: 1 }) },
    output: "{format:'cdp-screencast-frames',frames:Array}", examples: ["chrome-bridge screencast --tab=123 --duration=3s", "chrome-bridge screencast --tab=123 --duration=5s --file=/tmp/frames.json"],
  }),
  command(["eval"], "Evaluate JavaScript in the page.", {
    syntax: "chrome-bridge eval --tab=ID [--value-only] JAVASCRIPT", debuggerAttachment: "temporary", arguments: { ...tab, expression: arg("string", "JavaScript expression.", { required: true }), evalTimeout: arg("duration", "Page-side evaluation timeout.", { default: "5s" }), valueOnly: arg("boolean", "Return only the serializable value.", { default: false }) }, requirements: ["expression"],
    output: "CDP RemoteObject, or its value with --value-only.", examples: ["chrome-bridge eval --tab=123 'document.title' --value-only", "chrome-bridge eval --tab=123 --eval-timeout=10s 'fetch(`/api`).then(r=>r.json())'"],
  }),
  command(["extract"], "Extract repeated page records into bounded JSON.", {
    debuggerAttachment: "temporary", arguments: {
      ...tab,
      item: arg("string", "CSS selector for each result item.", { required: true }),
      within: arg("string", "CSS selector containing the result items."),
      schema: arg("json-object", "Field map using selector, property, attribute, and closest.", { required: true }),
      limit: arg("integer", "Maximum records returned.", { default: 100 }),
    },
    requirements: ["item", "schema"], output: "{items,total,returned,limited,url}",
    examples: ["chrome-bridge extract --tab=123 --item=article --schema='{\"text\":{\"property\":\"innerText\"}}'", "chrome-bridge extract --tab=123 --within=main --item=a --schema='{\"text\":{\"property\":\"innerText\"},\"url\":{\"property\":\"href\"}}'"],
  }),

  command(["click"], "Click a selector, accessibility backend node, or viewport point and report the final tab state.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, ...selector, ...semanticTarget, backendNodeId: arg("integer", "backendDOMNodeId from snapshot."), x: arg("number", "Viewport X coordinate."), y: arg("number", "Viewport Y coordinate."), double: arg("boolean", "Double click.", { default: false }), ...wait },
    requirements: ["one of selector, backendNodeId, role/name/text, or both x and y"], output: "{outcome,dispatchCompleted,sideEffectMayHaveOccurred,beforeUrl,lastKnownUrl,title,target,recommendedAction?,x,y,clickCount}",
    examples: ["chrome-bridge click --tab=123 --role=button --name='Save changes' --wait-role=status --wait-name=Saved", "chrome-bridge click --tab=123 --backend-node-id=456 --wait-for-url=/analytics"],
  }),
  command(["hover"], "Move the mouse over a selector or viewport point.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, ...selector, ...semanticTarget, x: arg("number", "Viewport X coordinate."), y: arg("number", "Viewport Y coordinate.") }, requirements: ["selector, role/name/text, or both x and y"], output: "{x,y,tag?,text?,target?}",
    examples: ["chrome-bridge hover --tab=123 --role=button --name=Account", "chrome-bridge hover --tab=123 --x=100 --y=200"],
  }),
  command(["drag"], "Drag between selectors or coordinate pairs.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, fromSelector: arg("string", "Source CSS selector."), toSelector: arg("string", "Destination CSS selector."), fromX: arg("number", "Source X."), fromY: arg("number", "Source Y."), toX: arg("number", "Destination X."), toY: arg("number", "Destination Y.") }, requirements: ["source and destination selectors or coordinate pairs"], output: "{from,to}",
    examples: ["chrome-bridge drag --tab=123 --from-selector='#a' --to-selector='#b'", "chrome-bridge drag --tab=123 --from-x=10 --from-y=10 --to-x=200 --to-y=200"],
  }),
  command(["type"], "Replace text in a selected editable element.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, selector: arg("string", "Editable element selector."), ...semanticTypeTarget, text: arg("string", "Text to insert.", { required: true }) }, requirements: ["selector or role/name/targetText", "text"], output: "{tag,length,target?}",
    examples: ["chrome-bridge type --tab=123 --role=textbox --name=Search --text='query'", "chrome-bridge type --tab=123 --selector=textarea --text='draft'"],
  }),
  command(["type-text"], "Insert text into the currently focused element.", {
    syntax: "chrome-bridge type-text --tab=ID TEXT", changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, text: arg("string", "Text to insert.", { required: true }) }, requirements: ["text"], output: "{length}",
    examples: ["chrome-bridge type-text --tab=123 'hello'", "chrome-bridge type-text --tab=123 --text='hello world'"],
  }),
  command(["press-key"], "Dispatch a key or shortcut.", {
    syntax: "chrome-bridge press-key --tab=ID KEY", changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, key: arg("string", "Key or modifier combination.", { required: true }) }, requirements: ["key"], output: "{key,code,modifiers,windowsVirtualKeyCode}",
    examples: ["chrome-bridge press-key --tab=123 Enter", "chrome-bridge press-key --tab=123 Meta+A"],
  }),
  command(["fill-form"], "Fill several form controls from a JSON array.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, elements: arg("json-array", "Array of {selector|role/name/text,value,exact?,nth?,within?}.", { required: true }) }, requirements: ["elements"], output: "Array<{selector?,tag,target?}>",
    examples: ["chrome-bridge fill-form --tab=123 --elements='[{\"role\":\"textbox\",\"name\":\"Search\",\"value\":\"hello\"}]'", "chrome-bridge fill-form --tab=123 --elements='[{\"selector\":\"#enabled\",\"value\":true}]'"],
  }),
  command(["upload-file"], "Set local files on a file input.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, selector: arg("string", "File-input selector."), ...semanticTarget, file: arg("path", "One input file path."), files: arg("json-array", "Several input file paths."), out: COMMON_ARGUMENTS.out }, requirements: ["selector or role/name/text", "file or files"], output: "{selector?,target?,files}; use --out for a result receipt.",
    examples: ["chrome-bridge upload-file --tab=123 --role=button --name='Upload photo' --file=/tmp/photo.png", "chrome-bridge upload-file --tab=123 --selector='#files' --files='[\"/tmp/a.txt\",\"/tmp/b.txt\"]' --out=/tmp/result.json"],
  }),
  command(["wait-for"], "Wait for a selector, page text, semantic target, or truthy JavaScript expression.", {
    syntax: "chrome-bridge wait-for --tab=ID (--selector=CSS|--text=TEXT|--role=ROLE|--name=NAME|--expression=JS)", debuggerAttachment: "temporary", arguments: { ...tab, ...selector, text: arg("string", "Visible page text fragment."), role: semanticTarget.role, name: semanticTarget.name, targetText: arg("string", "Accessible text, value, or description."), exact: semanticTarget.exact, nth: semanticTarget.nth, within: semanticTarget.within, state: arg("enum", "Required semantic state.", { enum: ["attached", "visible", "hidden", "enabled", "disabled"], default: "attached" }), expression: arg("string", "Truthy JavaScript expression."), ...thirtySecondDuration }, requirements: ["selector, text, role, name, targetText, or expression"], output: "{matched:true,elapsedMs,target?}",
    examples: ["chrome-bridge wait-for --tab=123 --role=button --name=Publish --state=enabled", "chrome-bridge wait-for --tab=123 --expression='document.readyState===\"complete\"'"],
  }),
  command(["handle-dialog"], "Accept or dismiss an open JavaScript dialog.", {
    changesPageState: true, debuggerAttachment: "temporary", arguments: { ...tab, action: arg("enum", "Dialog action.", { enum: ["accept", "dismiss"], default: "accept" }), promptText: arg("string", "Prompt response text.") }, output: "{action}",
    examples: ["chrome-bridge handle-dialog --tab=123 --action=accept", "chrome-bridge handle-dialog --tab=123 --action=dismiss"],
  }),
  command(["resize"], "Apply a persistent emulated viewport.", {
    changesPageState: true, debuggerAttachment: "persistent", arguments: { ...tab, width: arg("integer", "Viewport width.", { required: true }), height: arg("integer", "Viewport height.", { required: true }), deviceScaleFactor: arg("number", "Device pixel ratio.", { default: 1 }), mobile: arg("boolean", "Enable mobile metrics.", { default: false }), ttl: arg("duration", "Automatically clear emulation after this lease.") }, requirements: ["width", "height"], output: "{width,height,persistent:true,ttlMs?}",
    examples: ["chrome-bridge resize --tab=123 --width=1280 --height=800", "chrome-bridge emulate --tab=123 --clear"],
  }),
  command(["emulate"], "Apply or clear persistent device, CPU, location, media, header, and network overrides.", {
    changesPageState: true, debuggerAttachment: "persistent-until-clear", arguments: { ...tab, viewport: arg("string", "WIDTHxHEIGHT or WIDTHxHEIGHTxDPR."), mobile: arg("boolean", "Enable mobile mode."), cpu: arg("number", "CPU slowdown rate."), latitude: arg("number", "Latitude."), longitude: arg("number", "Longitude."), accuracy: arg("number", "Geolocation accuracy."), userAgent: arg("string", "User agent."), colorScheme: arg("enum", "Preferred color scheme.", { enum: ["light", "dark", "auto"] }), headers: arg("json-object", "Extra HTTP headers."), offline: arg("boolean", "Simulate offline mode."), latency: arg("number", "Network latency in milliseconds."), download: arg("number", "Download bytes per second."), upload: arg("number", "Upload bytes per second."), clear: arg("boolean", "Clear every emulation override.", { default: false }), ttl: arg("duration", "Automatically clear emulation after this lease.") }, output: "{configured:true,persistent:true,ttlMs?} or {cleared:true}",
    examples: ["chrome-bridge emulate --tab=123 --viewport=390x844x3 --mobile", "chrome-bridge emulate --tab=123 --clear"],
  }),

  command(["network", "capture"], "Capture traffic, optionally including a reload and network-idle wait.", {
    id: "network-capture", changesPageState: true, pageStateNotes: "Changes page state only when --reload is used; debugger capture state always changes temporarily.", requiresExplicitTab: true, debuggerAttachment: "persistent-for-capture", arguments: { ...tab, ...duration, reload: arg("boolean", "Reload after attaching so initial traffic is captured.", { default: false }), wait: arg("enum", "Stop after network idle instead of a fixed sleep.", { enum: ["network-idle"] }), bodies: arg("boolean", "Retain response bodies before cleanup.", { default: false }), har: arg("boolean", "Return HAR 1.2.", { default: false }), urlFilter: arg("string", "Only retain URLs containing this text."), ...networkPresentation }, output: "Network snapshot or HAR plus {initialLoadCaptured,bodiesRequested,bodiesCaptured,bodyCaptureErrors,wait}.",
    examples: ["chrome-bridge network capture --tab=123 --reload --wait=network-idle --bodies", "chrome-bridge network capture --tab=123 --duration=5s --url-filter=/api/"],
  }),
  command(["network", "start"], "Start a persistent network capture.", {
    id: "network-start", requiresExplicitTab: true, debuggerAttachment: "persistent", arguments: { ...tab, bodies: arg("boolean", "Retain response bodies.", { default: false }), urlFilter: arg("string", "Only retain matching URLs."), maxDuration: arg("duration", "Legacy automatic stop deadline."), ttl: arg("duration", "Automatically stop and remove the capture after this lease.") }, output: "{session,tabId,startedAt,ttlMs,bodiesRequested}",
    examples: ["chrome-bridge network start --tab=123 --bodies", "chrome-bridge network start --tab=123 --max-duration=1m"],
  }),
  command(["network", "tail"], "Read an active capture without stopping it.", { id: "network-tail", arguments: { ...tab, session: arg("string", "Capture session ID."), ...networkPresentation }, output: "Current raw or grouped network snapshot.", examples: ["chrome-bridge network tail --tab=123 --session=SESSION --errors-only", "chrome-bridge network tail --tab=123 --graphql"] }),
  command(["network", "stop"], "Stop a capture and release its debugger owner.", { id: "network-stop", requiresExplicitTab: true, arguments: { ...tab, session: arg("string", "Capture session ID."), har: arg("boolean", "Return HAR 1.2.", { default: false }) }, output: "Final network snapshot or HAR.", examples: ["chrome-bridge network stop --tab=123 --session=SESSION", "chrome-bridge network stop --tab=123 --har"] }),
  command(["network", "get-body"], "Read one response body before capture cleanup.", { id: "network-get-body", debuggerAttachment: "uses-existing", arguments: { ...tab, session: arg("string", "Capture session ID."), request: arg("string", "Request key or CDP request ID.", { required: true }), pretty: arg("boolean", "Parse JSON response bodies.", { default: false }) }, requirements: ["request"], output: "{base64Encoded,body,parsed?}", examples: ["chrome-bridge network get-body --tab=123 --session=SESSION --request=REQUEST --pretty", "chrome-bridge network get-body --tab=123 REQUEST"] }),
  command(["network", "export-har"], "Capture a timed flow in HAR 1.2 format.", { id: "network-export-har", requiresExplicitTab: true, debuggerAttachment: "persistent-for-capture", arguments: { ...tab, ...duration, bodies: arg("boolean", "Include response bodies.", { default: false }), urlFilter: arg("string", "Only retain matching URLs.") }, output: "HAR 1.2 object.", examples: ["chrome-bridge network export-har --tab=123 --duration=10s", "chrome-bridge network export-har --tab=123 --bodies --file=/tmp/page.har" ] }),
  command(["console", "capture"], "Capture console calls, exceptions, and log entries.", { id: "console-capture", aliases: ["console tail"], debuggerAttachment: "temporary", arguments: { ...tab, ...fiveSecondDuration }, output: "{startedAt,events}", examples: ["chrome-bridge console capture --tab=123 --duration=5s", "chrome-bridge console capture --tab=123 --file=/tmp/console.json"] }),

  command(["scripts", "list"], "List scripts known to the debugger.", { id: "scripts-list", debuggerAttachment: "temporary", arguments: { ...tab, wait: arg("duration", "Time to collect scriptParsed events.", { default: "300ms" }) }, output: "Array<ScriptDescriptor>", examples: ["chrome-bridge scripts list --tab=123", "chrome-bridge scripts list --tab=123 --wait=1s"] }),
  command(["scripts", "get"], "Read one loaded script source.", { id: "scripts-get", debuggerAttachment: "temporary", arguments: { ...tab, url: arg("string", "Exact URL or substring.", { required: true }), wait: arg("duration", "Script discovery time.", { default: "300ms" }) }, requirements: ["url"], output: "{url,scriptId,source}", examples: ["chrome-bridge scripts get --tab=123 --url=app.js", "chrome-bridge scripts get --tab=123 --url=https://example.com/app.js --file=/tmp/script.json"] }),
  command(["resources", "tree"], "Read the frame and resource tree.", { id: "resources-tree", debuggerAttachment: "temporary", arguments: tab, output: "CDP Page.getResourceTree result.", examples: ["chrome-bridge resources tree --tab=123", "chrome-bridge resources tree --tab=123 --file=/tmp/resources.json"] }),
  command(["resources", "get"], "Read a resource discovered in the resource tree.", { id: "resources-get", debuggerAttachment: "temporary", arguments: { ...tab, frame: arg("string", "Frame ID.", { required: true }), url: arg("url", "Resource URL.", { required: true }) }, requirements: ["frame", "url"], output: "{url,base64Encoded,content}", examples: ["chrome-bridge resources get --tab=123 --frame=FRAME --url=https://example.com/app.css", "chrome-bridge resources get --tab=123 --frame=FRAME --url=https://example.com/app.js --file=/tmp/resource.json"] }),
  command(["page", "mhtml"], "Capture the page as MHTML.", { id: "page-mhtml", debuggerAttachment: "temporary", arguments: tab, output: "{format:'mhtml',data}; --file writes raw MHTML.", examples: ["chrome-bridge page mhtml --tab=123 --file=/tmp/page.mhtml", "chrome-bridge page mhtml --tab=123"] }),
  command(["cookies"], "Read cookies applicable to the current tab URL.", { debuggerAttachment: "temporary", arguments: tab, output: "Array<Cookie>", examples: ["chrome-bridge cookies --tab=123", "chrome-bridge cookies --tab=123 --file=/tmp/cookies.json"] }),
  command(["storage"], "Read local, session, IndexedDB, and Cache API storage.", { debuggerAttachment: "temporary", arguments: { ...tab, limit: arg("integer", "Maximum records per store/cache."), bodies: arg("boolean", "Include cache response bodies.", { default: false }) }, output: "{localStorage,sessionStorage,indexedDB,caches}", examples: ["chrome-bridge storage --tab=123 --limit=100", "chrome-bridge storage --tab=123 --bodies --file=/tmp/storage.json"] }),
  command(["targets"], "List debugger targets, and frame data when a tab is supplied.", { debuggerAttachment: "temporary-with-tab", arguments: tab, output: "{debuggerTargets,frames?}", examples: ["chrome-bridge targets", "chrome-bridge targets --tab=123"] }),
  command(["performance", "metrics"], "Read current performance and heap metrics.", { id: "performance-metrics", debuggerAttachment: "temporary", arguments: tab, output: "{metrics,heap}", examples: ["chrome-bridge performance metrics --tab=123", "chrome-bridge performance metrics --tab=123 --file=/tmp/metrics.json"] }),
  command(["performance", "profile"], "Record a V8 CPU profile.", { id: "performance-profile", debuggerAttachment: "temporary", arguments: { ...tab, ...fiveSecondDuration, interval: arg("integer", "Sampling interval in microseconds.") }, output: "V8 CPU profile.", examples: ["chrome-bridge performance profile --tab=123 --duration=5s", "chrome-bridge performance profile --tab=123 --duration=10s --file=/tmp/profile.json"] }),
  command(["performance", "trace"], "Record a Chrome performance trace.", { id: "performance-trace", debuggerAttachment: "temporary", arguments: { ...tab, ...fiveSecondDuration, categories: arg("csv", "Trace category list."), traceConfig: arg("json-object", "Full CDP trace config.") }, output: "{format:'json',data}; --file writes raw trace JSON.", examples: ["chrome-bridge performance trace --tab=123 --duration=5s --file=/tmp/trace.json", "chrome-bridge performance trace --tab=123 --categories=devtools.timeline,loading"] }),

  command(["history", "search"], "Search Chrome history.", { id: "history-search", arguments: { query: arg("string", "Search text.", { default: "" }), startTime: arg("number", "Earliest epoch milliseconds.", { default: 0 }), limit: arg("integer", "Maximum results.") }, output: "Array<HistoryItem>", examples: ["chrome-bridge history search --query=example --limit=20", "chrome-bridge history search --start-time=1767225600000"] }),
  command(["bookmarks", "tree"], "Read the bookmark tree.", { id: "bookmarks-tree", output: "Array<BookmarkTreeNode>", examples: ["chrome-bridge bookmarks tree", "chrome-bridge bookmarks tree --file=/tmp/bookmarks.json"] }),
  command(["bookmarks", "search"], "Search bookmarks.", { id: "bookmarks-search", arguments: { query: arg("string", "Title or URL text.", { default: "" }) }, output: "Array<BookmarkTreeNode>", examples: ["chrome-bridge bookmarks search --query=example", "chrome-bridge bookmarks search --query=docs"] }),
  command(["downloads", "search"], "Search download records.", { id: "downloads-search", arguments: { query: arg("string", "Filename or URL text."), limit: arg("integer", "Maximum results.") }, output: "Array<DownloadItem>", examples: ["chrome-bridge downloads search --query=report --limit=20", "chrome-bridge downloads search --file=/tmp/downloads.json"] }),
  command(["extensions", "list"], "List installed extensions.", { id: "extensions-list", output: "Array<ExtensionInfo>", examples: ["chrome-bridge extensions list", "chrome-bridge extensions list --file=/tmp/extensions.json"] }),
  command(["extension", "reload"], "Reload another extension.", { id: "extension-reload", changesPageState: true, arguments: { extension: arg("string", "Extension ID.", { required: true }) }, requirements: ["extension"], output: "{reloaded:true,extension:{id,name,type}}", examples: ["chrome-bridge extension reload --extension=abcdefghijklmnopabcdefghijklmnop", "chrome-bridge extensions list"] }),
  command(["chrome", "call"], "Call a granted Chrome Extension API method.", { id: "chrome-call", changesPageState: true, arguments: { api: arg("string", "Chrome API namespace.", { required: true }), method: arg("string", "Method name.", { required: true }), args: arg("json-array", "Arguments in method order.", { default: [] }) }, requirements: ["api", "method"], output: "Raw Chrome API result.", examples: ["chrome-bridge chrome call --api=topSites --method=get", "chrome-bridge chrome call --api=sessions --method=getRecentlyClosed --args='[{\"maxResults\":10}]'"] }),
  command(["cdp", "send"], "Send an arbitrary CDP command.", { id: "cdp-send", changesPageState: true, debuggerAttachment: "temporary-or-existing", arguments: { ...tab, target: arg("string", "Debugger target ID."), bridgeSession: arg("string", "Persistent Chrome Bridge session ID."), sessionId: arg("string", "Flat child-session ID."), method: arg("string", "Domain.method."), domain: arg("string", "Domain when --command is used."), command: arg("string", "Command when --domain is used."), params: arg("json-object", "CDP parameters.", { default: {} }) }, requirements: ["method or domain plus command", "tab, target, or bridgeSession"], output: "Raw CDP result.", examples: ["chrome-bridge cdp send --tab=123 --method=Runtime.evaluate --params='{\"expression\":\"1+1\"}'", "chrome-bridge cdp send --bridge-session=SESSION --method=Debugger.resume"] }),
  command(["cdp", "events"], "Collect one CDP domain's events.", { id: "cdp-events", debuggerAttachment: "temporary-or-existing", arguments: { ...tab, target: arg("string", "Debugger target ID."), bridgeSession: arg("string", "Persistent session ID."), domain: arg("string", "CDP domain.", { required: true }), enableParams: arg("json-object", "Parameters for Domain.enable."), ...fiveSecondDuration }, requirements: ["domain", "tab, target, or bridgeSession"], output: "Array<{method,params,source,at}>", examples: ["chrome-bridge cdp events --tab=123 --domain=Network --duration=5s", "chrome-bridge cdp events --bridge-session=SESSION --domain=Debugger --duration=10s"] }),
  command(["cdp", "session-start"], "Start a persistent debugger session.", { id: "cdp-session-start", changesPageState: true, debuggerAttachment: "persistent", arguments: { ...tab, target: arg("string", "Debugger target ID."), ttl: arg("duration", "Automatically stop the session after this lease.") }, requirements: ["tab or target"], output: "{session,target,startedAt,ttlMs?}", examples: ["chrome-bridge cdp session-start --tab=123 --ttl=5m", "chrome-bridge cdp session-start --target=WORKER_ID"] }),
  command(["cdp", "session-stop"], "Stop a persistent debugger session.", { id: "cdp-session-stop", changesPageState: true, arguments: { bridgeSession: arg("string", "Persistent session ID.", { required: true }) }, requirements: ["bridgeSession"], output: "{stopped:true,session,target}", examples: ["chrome-bridge cdp session-stop --bridge-session=SESSION", "chrome-bridge status"] }),
];

const BY_ID = new Map(COMMANDS.map((entry) => [entry.id, entry]));
const BY_NAME = new Map(COMMANDS.map((entry) => [entry.name, entry]));
for (const entry of COMMANDS) for (const alias of entry.aliases) BY_NAME.set(alias, entry);

export const COMMAND_GROUPS = [...new Set(COMMANDS.filter((entry) => entry.path.length > 1).map((entry) => entry.path[0]))].sort();

export function commandById(id) {
  return BY_ID.get(id);
}

export function resolveCommand(positionals) {
  const two = positionals.slice(0, 2).join(" ");
  if (BY_NAME.has(two)) return { entry: BY_NAME.get(two), consumed: 2 };
  const one = positionals[0];
  if (BY_NAME.has(one)) return { entry: BY_NAME.get(one), consumed: 1 };
  return null;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function schema() {
  return {
    schemaVersion: 1,
    commonArguments: Object.fromEntries(Object.entries(COMMON_ARGUMENTS).map(([name, value]) => [`--${kebab(name)}`, value])),
    commands: COMMANDS.map((entry) => ({
      ...entry,
      arguments: publicArguments(entry),
    })),
  };
}

export function helpFor(words = []) {
  const query = words.join(" ");
  const exact = BY_NAME.get(query) || BY_ID.get(query);
  if (exact) {
    const arguments_ = publicArguments(exact);
    return {
      ...exact,
      arguments: arguments_,
      requiredArguments: Object.keys(arguments_).filter((name) => arguments_[name].required),
      optionalArguments: Object.keys(arguments_).filter((name) => !arguments_[name].required),
    };
  }
  if (words.length === 1 && COMMAND_GROUPS.includes(words[0])) {
    return { group: words[0], commands: COMMANDS.filter((entry) => entry.path[0] === words[0]).map(({ name, summary }) => ({ name, summary })) };
  }
  return {
    usage: "chrome-bridge <command> [options]",
    help: "chrome-bridge help <command> | chrome-bridge <command> --help",
    schema: "chrome-bridge commands --json",
    commands: COMMANDS.map(({ name, summary }) => ({ name, summary })),
  };
}

function publicArguments(entry) {
  return Object.fromEntries(Object.entries({ ...(entry.usesCommonArguments ? COMMON_ARGUMENTS : {}), ...entry.arguments }).map(([name, value]) => {
    const required = Boolean(value.required || entry.requirements.includes(name) || (name === "tab" && entry.requiresExplicitTab && !["cdp-send", "cdp-session-start"].includes(entry.id)));
    return [`--${kebab(name)}`, { ...value, required }];
  }));
}

function distance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const old = previous[column];
      previous[column] = Math.min(previous[column] + 1, previous[column - 1] + 1, diagonal + (left[row - 1] === right[column - 1] ? 0 : 1));
      diagonal = old;
    }
  }
  return previous[right.length];
}

export function suggestions(value, limit = 3) {
  const query = String(value || "").replaceAll("-", " ");
  return COMMANDS.map((entry) => ({ name: entry.name, score: distance(query, entry.name) - (entry.name.startsWith(query.split(" ")[0]) ? 2 : 0) }))
    .sort((left, right) => left.score - right.score || left.name.localeCompare(right.name))
    .slice(0, limit)
    .map((item) => item.name);
}

export function coerceAndValidate(entry, params, parseDuration) {
  const definitions = { ...COMMON_ARGUMENTS, ...entry.arguments };
  const result = { ...params };
  const unknown = Object.keys(result).filter((name) => !(name in definitions) && name !== "help" && name !== "json");
  if (unknown.length) {
    const likely = Object.keys(definitions).map((name) => ({ name, score: distance(unknown[0], name) })).sort((left, right) => left.score - right.score)[0];
    throw new Error(`Unknown option --${kebab(unknown[0])} for ${entry.name}.${likely ? ` Did you mean --${kebab(likely.name)}?` : ""} Use: ${entry.syntax}`);
  }
  for (const [name, value] of Object.entries(result)) {
    const definition = definitions[name];
    if (!definition || value === undefined) continue;
    if (definition.type === "boolean") {
      if (![true, false, "true", "false"].includes(value)) throw new Error(`--${kebab(name)} must be true or false. Use: ${entry.syntax}`);
      result[name] = value === true || value === "true";
    } else if (["integer", "number"].includes(definition.type)) {
      const number = Number(value);
      if (!Number.isFinite(number) || (definition.type === "integer" && !Number.isInteger(number))) throw new Error(`--${kebab(name)} must be ${definition.type === "integer" ? "an integer" : "a number"}. Use: ${entry.syntax}`);
      result[name] = number;
    } else if (definition.type === "tab") {
      result[name] = /^\d+$/.test(String(value)) ? Number(value) : String(value);
    } else if (definition.type === "duration") {
      result[name] = parseDuration(value);
    } else if (definition.type.startsWith("json") && typeof value === "string") {
      try { JSON.parse(value); } catch { throw new Error(`--${kebab(name)} must be valid JSON. Use: ${entry.syntax}`); }
    }
    if (definition.enum && !definition.enum.includes(result[name])) throw new Error(`--${kebab(name)} must be one of: ${definition.enum.join(", ")}. Use: ${entry.syntax}`);
  }
  for (const [name, definition] of Object.entries(entry.arguments)) {
    if (definition.required && result[name] === undefined) throw new Error(`${entry.name} requires --${kebab(name)}. Use: ${entry.syntax}\nExample: ${entry.examples[0]}`);
  }
  if (entry.requiresExplicitTab && entry.arguments.tab && result.tab === undefined && result.target === undefined && result.bridgeSession === undefined) {
    throw new Error(`${entry.name} requires an explicit --tab=ID because it can change browser state.\nExample: ${entry.examples[0]}`);
  }
  const semantic = result.role || result.name || result.targetText || (result.text && !["type", "wait-for"].includes(entry.id));
  if (entry.id === "click" && !(result.selector || result.backendNodeId !== undefined || semantic || (Number.isFinite(result.x) && Number.isFinite(result.y)))) {
    throw new Error(`click requires a target. Use --role/--name/--text, --selector, --backend-node-id, or --x and --y.\nExample: chrome-bridge click --tab=123 --role=button --name=Save`);
  }
  if (entry.id === "hover" && !(result.selector || semantic || (Number.isFinite(result.x) && Number.isFinite(result.y)))) throw new Error(`hover requires a semantic target, --selector, or --x and --y. Use: ${entry.syntax}`);
  if (entry.id === "drag" && !(result.fromSelector || [result.fromX, result.fromY].every(Number.isFinite))) throw new Error(`drag requires --from-selector or --from-x and --from-y. Use: ${entry.syntax}`);
  if (entry.id === "drag" && !(result.toSelector || [result.toX, result.toY].every(Number.isFinite))) throw new Error(`drag requires --to-selector or --to-x and --to-y. Use: ${entry.syntax}`);
  if (entry.id === "type" && !(result.selector || result.role || result.name || result.targetText)) throw new Error(`type requires --selector or a semantic target. Use: ${entry.syntax}`);
  if (entry.id === "upload-file" && !(result.selector || semantic)) throw new Error(`upload-file requires --selector or a semantic target. Use: ${entry.syntax}`);
  if (entry.id === "upload-file" && result.file === undefined && result.files === undefined) throw new Error(`upload-file requires --file or --files. Use: ${entry.syntax}`);
  if (entry.id === "wait-for" && !result.selector && !result.text && !result.role && !result.name && !result.targetText && !result.expression) throw new Error(`wait-for requires a selector, text, semantic target, or expression. Use: ${entry.syntax}`);
  if (entry.id === "locate" && !result.text && !result.role && !result.name) throw new Error(`locate requires --text, --role, or --name. Use: ${entry.syntax}`);
  if (entry.id === "watch" && [result.urlChanges, result.selector, result.request, result.console].filter(Boolean).length !== 1) throw new Error(`watch requires exactly one of --url-changes, --selector, --request, or --console. Use: ${entry.syntax}`);
  if (entry.id === "cdp-send" && !result.method && !(result.domain && result.command)) throw new Error(`cdp send requires --method or --domain and --command. Use: ${entry.syntax}`);
  return result;
}
