---
name: x-chrome-bridge
description: Inspect and safely operate X in the user's existing signed-in Chrome session through chrome-bridge. Use for X timelines, profiles, followers, verified follow-backs, follows and unfollows, posts, replies, likes, bookmarks, media uploads, API request discovery, rate-limit monitoring, or any X task that must preserve account safety and verify mutations.
---

# X via Chrome Bridge

Use this as the X-specific layer on top of `chrome-bridge`. Read [the base skill](../chrome-bridge/SKILL.md) and only the command or state references that the task needs. Use `chrome-bridge` as the only browser interface.

## Ground the X tab

1. Run `chrome-bridge status` and `chrome-bridge list-tabs`.
2. Select the intended `x.com` tab explicitly with `--tab=ID` and inspect its URL and visible state.
3. Activate the tab before real mouse or keyboard input. A background-tab click can report success without X receiving the action.
4. Inspect the smallest relevant DOM surface before acting. Prefer a targeted `eval` against one `UserCell`, composer, post, or dialog over a whole-page dump.

## Separate discovery from mutation

Keep read-only work read-only. Navigation, passive DOM inspection, response-body retrieval, and paced scrolling are acceptable for discovery; follows, posts, replies, likes, bookmarks, messages, and form submissions require explicit user approval.

Before a mutation, resolve the exact account or content, show or confirm the action set, and inspect the current control state. Once the user approves an exact set, continue through that set at the safe X rate instead of imposing an arbitrary smaller batch. Perform one mutation at a time, wait at least 3 seconds, and verify it before the next one.

Stop before another mutation when any of these occurs:

- X returns HTTP 429 or `x-rate-limit-remaining: 0`.
- X shows a rate-limit warning, authentication change, account lock, or challenge that interrupts the flow.
- A mutation returns a non-2xx response, produces an unexpected target, or remains ambiguous after a passive recheck.

Do not provoke a 429 to prove that the limit is active, bypass X protections, or replay captured authenticated requests to accelerate work.

## Enumerate followers without hammering X

Treat X lists as virtualized and paginated. Nodes can leave the DOM while scrolling, and recommendation cells can appear after the real list.

- Advance no more than one viewport per step.
- Wait at least 2 seconds and for new content or network activity to settle before the next step.
- Collect unique handles after each step; do not use a sub-second `scrollTo(document.body.scrollHeight)` loop.
- Stop after two paced advances add no relevant records.
- Preserve partial results when a list is large instead of restarting the scan.

For verified follow-backs, use `https://x.com/HANDLE/verified_followers` and require all three signals from the same `[data-testid=UserCell]`:

1. The page is X's **Verified Followers** view.
2. The cell says **Follows you**.
3. The cell button says **Follow back**.

Exclude cells that say **Following** or **Pending**. Exclude generic **Follow** suggestions that do not say **Follows you**.

## Verify follow mutations against X

Use this sequence for approved follows:

1. Activate the X tab.
2. Recheck that the target cell still says **Follows you** and **Follow back**.
3. Record the button's unique `data-testid` and ensure its bounding box is inside the viewport.
4. Start a network capture filtered to `friendships/create` without response bodies.
5. Click the unique button once, wait at least 3 seconds, and confirm that the same cell now says **Following**.
6. Inspect the captured `POST /i/api/1.1/friendships/create.json` response. Require HTTP 200 and read `x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset`.
7. Continue only while the approved set remains and X reports capacity. Stop before the next click when the remaining counter reaches zero.

A missing capture alone is not proof that the follow failed. If the UI says **Following**, pause and compare the next successful response's rate-limit decrement; a drop larger than one can account for the earlier request. Never click the same account again while its UI says **Following**.

## Inspect X API traffic safely

Capture around one necessary navigation or reload, filter to `/i/api/` or the narrow endpoint family, and request bodies only when the task needs them. Summarize endpoint, method, status, payload shape, response shape, and rate-limit headers.

Never print or retain authorization headers, cookies, CSRF tokens, client transaction IDs, or signed-in request URLs containing sensitive identifiers. Write raw captures to a temporary path, extract the minimum safe result, then move the raw files to Trash.

Do not call a private X endpoint directly merely because a captured request reveals it. Prefer X's own UI flow unless the user explicitly requests API execution and the action remains within the approved scope.

## Handle composers, uploads, and dialogs

- Use `type --selector` to replace composer text. Do not rely on `press-key Meta+A`; the current bridge can dispatch the keys without triggering Select All.
- Verify the complete composer text before clicking Post or Reply, then verify the resulting post or response request.
- Use `upload-file --files='["/absolute/path"]'` for media. Do not use upload-file's singular `--file`; the CLI also treats `--file` as an output destination and can overwrite the selected file.
- Treat X confirmation sheets and modals as DOM UI. Inspect and click their explicit buttons instead of using JavaScript-dialog handling.

## Clean up and report

Stop every network capture and CDP session, clear emulation, and run `chrome-bridge status`. Leave the user's existing X tabs open; close only temporary tabs created for the task when they are no longer useful.

Report confirmed mutations, ambiguous states, the last observed rate-limit count and reset time, and the exact reason for stopping. Do not claim a mutation from a click receipt alone.
