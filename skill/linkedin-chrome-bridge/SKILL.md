---
name: linkedin-chrome-bridge
description: Read the user's LinkedIn account data and operate their existing signed-in LinkedIn session through chrome-bridge. Use to inspect profiles and activity, retrieve or summarize conversations and messages, search the inbox, draft or send messages, create or publish posts, upload media, manage connections and invitations, review followers, edit profile or company content, inspect jobs, request a LinkedIn data archive, discover the UI's current API requests, or verify any LinkedIn action without using a separate browser profile.
---

# LinkedIn Account Operations via Chrome Bridge

Use this as the task-oriented LinkedIn layer on top of [the base Chrome Bridge skill](../chrome-bridge/SKILL.md). Read only the base command or state references needed for the task. Use `chrome-bridge` as the only browser interface and operate the user's existing signed-in session.

## Interpret the request as an operation

Do the requested LinkedIn job, not a generic site inspection.

- **Get my messages**: return useful conversation or message records. Do not send anything.
- **Draft a message or post**: write the draft in the response. Put it into LinkedIn only when the user asks.
- **Send, post, connect, accept, follow, edit, or apply**: the exact imperative request authorizes that exact action when the recipient, content, audience, and target are unambiguous. Do not ask for duplicate confirmation.
- **Review, identify, find, list, or summarize**: remain read-only, except that opening an unread conversation can mark it read. Inventory unread cards without opening them unless the user asked to read their contents.
- **Run my LinkedIn**: break the request into concrete account operations and report results by person, conversation, post, profile section, or job rather than returning raw DOM or API traffic.

Ask only when a missing recipient, final text, attachment, or other choice could materially change the external action. When a post request omits the audience, retain LinkedIn's currently displayed audience and report it; ask only if the audience is not visible or the request implies different reach. For a batch mutation, resolve the full set first and default to no more than five approved actions at a time.

## Start from the owning route

Run `chrome-bridge status` and `chrome-bridge list-tabs`, select the intended `linkedin.com` tab with `--tab=ID`, and inspect its URL and narrow visible state. Reuse an existing LinkedIn tab when practical; use a temporary background tab for discovery that should not disturb the user's page.

| Account job | Current route or surface |
|---|---|
| Read or send messages | `/messaging/` |
| Read or edit the user's profile | `/in/me/` |
| Review the user's posts and activity | `/in/me/recent-activity/all/` |
| Read the feed or create a post | `/feed/` |
| Manage connection suggestions | `/mynetwork/grow/` |
| Manage invitations | `/mynetwork/invitation-manager/` |
| List connections | `/mynetwork/invite-connect/connections` |
| Review people followed or following | `/mynetwork/network-manager/people-follow/` |
| Request LinkedIn's official archive | `/mypreferences/d/download-my-data` |

After navigation, wait for a route-specific stable selector. Activate the tab before real mouse or keyboard input; background-tab clicks can report success without LinkedIn receiving them.

## Retrieve account data

Choose the smallest source that answers the question:

1. **Profile snapshot**: navigate to `/in/me/`. Extract identity and visible sections from `main#workspace`; locate sections by headings such as About, Activity, Experience, Education, Skills, Recommendations, and Interests. Use a section's own **Show all** or **… more** control when the requested data is collapsed. Never identify a section by LinkedIn's generated hash classes.
2. **Owned activity**: use `/in/me/recent-activity/all/` and its Posts, Comments, Reactions, or other available filter. Collect each unique activity's type, date, text, canonical link, and visible engagement counts. Scroll the actual container one viewport at a time.
3. **Network data**: use the connection, invitation, and follow routes above. Return stable profile URLs plus the displayed name, headline, relationship state, and relevant date or mutual-connection evidence.
4. **Inbox data**: use the messaging workflow below. Treat message bodies as private user data; return the requested records, not an unbounded inbox dump.
5. **Structured page data**: capture the normal UI request while performing a normal navigation or paced scroll. Extract records from the response body when this is more complete than the rendered virtualized list. Do not replay the authenticated request.
6. **Official archive**: use `/mypreferences/d/download-my-data` for the full LinkedIn export or the currently offered categories. Selecting archive options and clicking **Request archive** starts an external data-generation workflow, so do it only when the user asked to request the archive. Verify that LinkedIn accepted the request and report the stated delivery behavior.

For lists, deduplicate by canonical profile, post, conversation, or job identity. Return partial results with the number collected when two paced advances add no new records.

## Read the inbox and messages

LinkedIn's current messaging route uses these stable semantic classes:

- Conversation list: `.msg-conversations-container__conversations-list`
- Conversation card: `.msg-conversation-listitem`
- Selectable card target: `.msg-conversation-listitem__link`
- Participant names: `.msg-conversation-listitem__participant-names`
- Card timestamp: `.msg-conversation-listitem__time-stamp`
- Latest-message snippet: `.msg-conversation-card__message-snippet`
- Inbox search: `#search-conversations`
- Active participant profile: `.msg-thread__link-to-profile`
- Thread scroll container: `.msg-s-message-list`
- Message event: `.msg-s-message-list__event`
- Message body: `.msg-s-event-listitem__body`
- Sender profile when rendered: `.msg-s-message-group__profile-link`

To list recent conversations, inspect cards without clicking them and return participant, card timestamp, latest snippet, and visible unread/starred state. Scope every extracted field to the same `.msg-conversation-listitem`. If the user requests unread inventory, do not open those cards because opening one can change its read state. If the user requests the latest message body or a summary and the card snippet is clipped, open the exact thread and read the full event; that content request authorizes the possible read-state change, which should be reported.

To find a conversation, use `type --selector='#search-conversations'` with the person's name, wait for the list to settle, and match the exact participant text. Clear the search with the same `type` command when finished. If search is unnecessary, inspect the loaded cards before scrolling the conversation list one viewport at a time with at least two seconds between advances.

To read a conversation:

1. Select the exact card through its scoped `.msg-conversation-listitem__link` and wait for the thread to load.
2. Verify the participant name and profile URL through `.msg-thread__link-to-profile` before reading or composing.
3. Extract `.msg-s-message-list__event` records in DOM order. For each event, collect sender, timestamp, `.msg-s-event-listitem__body` text, and any visible attachment or reaction metadata. Associate grouped messages without a repeated profile link with the most recent rendered sender group.
4. For older messages, move `.msg-s-message-list` toward its top by at most one `clientHeight`, wait at least two seconds, and deduplicate events. Stop after two advances add no events.
5. Return the requested slice as structured records such as `{participant, direction, timestamp, body, attachments}`. Do not print thread IDs, cookies, or raw response payloads.

## Draft or send a message

For a draft-only request, write the message in the response and leave LinkedIn untouched unless the user explicitly wants the draft placed in the composer.

For sending:

1. Open or search for the exact conversation and verify `.msg-thread__link-to-profile` against the intended recipient.
2. Replace the editor through `.msg-form__contenteditable[aria-label="Write a message…"]` using `type --selector`. Reread its complete `innerText`; do not rely on the CLI's inserted character count.
3. Upload requested attachments through the scoped `.msg-form input[type=file]` using `upload-file --files='["/absolute/path"]'`, then verify the rendered filename or preview before sending.
4. Resolve the visible enabled **Send** button inside the same `.msg-form`; it may appear only after text is present. Do not use the adjacent **Open send options** control unless the user requested a scheduled or alternate send.
5. Click once, wait for the form and thread to settle, then confirm a new outgoing `.msg-s-message-list__event` with the exact body and attachment state. Also confirm the corresponding request succeeded when network verification is available.

If the recipient or body is wrong after typing, replace or clear the composer before leaving. A draft can persist in LinkedIn even when it was never sent.

## Create and publish a post

Use `/feed/`. The current entry point is the visible anchor `[href="/preload/sharebox/"]` containing a descendant labeled `Start a post`.

1. For draft-only work, produce the draft in the response without opening the composer.
2. For a requested LinkedIn post, open the entry point and identify the one visible `[role=dialog]` by checking rendered rectangles. Ignore hidden dialogs retained in the DOM.
3. Within that visible dialog, locate the post textbox by role or `contenteditable=true`, enter the exact approved text with `type --selector`, and reread the full draft from the editor.
4. Verify the displayed posting identity and audience. When the request omits an audience, keep the displayed audience unchanged and report it. Change it only when the request specifies another audience; audience changes can open another sheet that must be scoped and closed or completed before continuing. If no audience is visible, stop and ask before publishing.
5. Upload requested media through the visible dialog's `input[type=file]` using `--files`, then verify every preview, order, alt text when available, and removal control before publishing.
6. Resolve **Post** only inside the visible composer dialog. Click once, wait for the dialog to close, and verify the new feed item by the user's profile identity and exact text. Confirm the corresponding successful request when available.

If the task stops before publishing, close the visible composer with its scoped **Close** control and verify that no visible composer dialog remains. Do not leave accidental drafts or dialogs open.

## Manage posts, connections, and profile content

Scope feed work to `[data-testid=mainFeed]`. Treat descendants with `[role=listitem]` and visible text beginning with **Feed post** as candidate cards, then identify the intended card by author profile link, text, and promoted state. Locate Reaction, Comment, Repost, Follow, Save, or menu controls only inside that card. Verify the changed state and successful request after one action.

Suggestion cards expose `Invite NAME to connect` and `Remove NAME as a suggestion`. Scope either button to the card containing the same profile URL, headline, and mutual-connection evidence. Treat adding a note, sending without a note, accepting, ignoring, withdrawing, following, and removing a suggestion as different operations. Perform only the requested one and verify **Pending**, **Message**, accepted, or removed state.

For profile or company-page edits, navigate to the owning page, identify the section by its visible heading, open that section's scoped **Edit** control, and read every current field before changing one. Enter only the requested fields, reread the visible review state, save once, and verify the public or admin view reflects the change. Never overwrite an unrelated field because LinkedIn grouped it into the same form.

For jobs, identify the job by title, company, and canonical URL. Use user-provided application answers and inspect every review screen. A direct request to apply authorizes the specified application, but stop for missing answers or an unexpected profile/resume change. Verify submission; never withdraw an application incidentally.

## Inspect LinkedIn requests safely

Discover the request family from the current route. LinkedIn currently uses `/flagship-web/rsc-action/actions/`, `/rest/`, and, on some surfaces, `/voyager/api/`.

Start a narrow capture before the normal UI action or navigation, then use `network tail` to find the relevant successful request and `network get-body` while the capture remains attached. Summarize the sanitized method, path family, status, payload shape, response shape, record count, and rate-limit evidence. Prefer captured responses for data retrieval; never reproduce a write by replaying an authenticated request.

Raw captures can contain message bodies, application answers, profile data, cookies, CSRF values, tracking IDs, and signed-in URLs. Write them only to a temporary absolute path, extract the requested safe result, stop the capture, and move raw files to Trash.

## Pace and verify account operations

LinkedIn's current desktop shell often scrolls inside `main#workspace`, while messaging uses its own list and thread containers. Resolve the actual container; `window.scrollBy` can do nothing.

- Advance at most one `clientHeight`, wait at least two seconds, and stop after two advances add no relevant records.
- Perform account mutations one at a time with at least three seconds between them.
- Stop before another mutation on HTTP 429, throttling, checkpoints, authentication changes, account restrictions, repeated non-2xx responses, or ambiguous state.
- Do not run tight scroll loops, burst clicks, parallel browser mutations, repeated carousel actions, or captured-request replays.
- Treat click success as input delivery, not proof. Verify the scoped UI result and, when available, the successful network request.

## Clean up and report

Stop every capture and CDP session, clear emulation, and run `chrome-bridge status`. Restore existing scroll positions when practical, leave the user's original LinkedIn tabs open, and close only temporary tabs created for the task.

Report retrieved records in the shape useful to the request. For mutations, report the exact recipient or target, submitted content or action, UI confirmation, network confirmation when available, and any rate-limit or checkpoint evidence. Separate confirmed results from ambiguous states.
