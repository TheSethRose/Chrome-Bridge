---
name: x-chrome-bridge
description: Retrieve X data and operate the user's signed-in x.com session through chrome-bridge. Use for timelines, search, profiles, posts, replies, threads, media, likes, reposts, bookmarks, DMs, notifications, followers, lists, communities, Spaces, settings, archives, monetization, API traffic, or rate limits.
---

# X Account Operations via Chrome Bridge

Use this as the task-oriented X layer on top of [the base Chrome Bridge skill](../chrome-bridge/SKILL.md). Read only the base command or state references needed for the current operation. Use `chrome-bridge` as the only browser interface and operate the user's existing signed-in Chrome session.

## Interpret the request as an operation

Do the requested account job instead of returning generic DOM or network observations.

- **Get, find, list, review, identify, or summarize**: retrieve useful records without posting, following, liking, bookmarking, sending, or changing settings.
- **Draft a post, reply, thread, article, or DM**: write the draft in the response. Put it into X only when the user asks.
- **Post, reply, send, follow, unfollow, like, repost, quote, bookmark, join, edit, schedule, or delete**: an exact imperative request authorizes that exact action when its target and content are unambiguous. Do not request duplicate confirmation.
- **Get my DMs**: list or read the requested conversations. Opening an unread conversation can mark it read; inventory unread items without opening them unless the request requires their contents.
- **Run my X account**: break the request into concrete operations and report results by account, post, conversation, notification, list, community, Space, or setting.

Ask only when a missing recipient, final content, attachment, schedule, poll choice, destructive target, or other decision could materially change the action. An explicit batch size authorizes that set; if no size is stated, default to five mutations. Continue through an approved set at the safe X rate unless a stop condition occurs.

## Ground the intended X surface

1. Run `chrome-bridge status` and `chrome-bridge list-tabs`.
2. Select the exact `x.com` tab with `--tab=ID`; inspect its URL and the smallest relevant visible state.
3. Reuse the user's current X tab when that will not disturb their work. Use one temporary background tab for multi-route discovery, then close it.
4. Activate the tab before real mouse or keyboard input. A background-tab click can report success without X receiving the action.
5. Prefer stable routes, roles, accessible names, and `data-testid` values. Scope every generic control to its owning post, user cell, composer, conversation, dialog, or settings form.

## Map account functionality to routes

Replace `HANDLE` with the intended account and resolve IDs from links already rendered by X.

| Functionality | Current route or surface |
|---|---|
| For You and Following timelines | `/home` |
| Explore and trends | `/explore` and `/explore/tabs/{for_you,trending,news,sports,entertainment}` |
| Search posts, people, media, or lists | `/search` through `[data-testid="SearchBox_Search_Input"]` |
| Notifications | `/notifications`, `/notifications/priority`, `/notifications/mentions` |
| Direct messages and requests | `/i/chat` |
| Profile posts | `/HANDLE` |
| Replies, highlights, articles, media, likes | `/HANDLE/with_replies`, `/HANDLE/highlights`, `/HANDLE/articles`, `/HANDLE/media`, `/HANDLE/likes` |
| Following, followers, verified followers | `/HANDLE/following`, `/HANDLE/followers`, `/HANDLE/verified_followers` |
| Bookmarks and bookmark folders | `/i/bookmarks` |
| Lists | `/HANDLE/lists`; details use `/i/lists/ID` |
| Communities | `/HANDLE/communities`, `/HANDLE/communities/explore`; details use `/i/communities/ID` |
| Long-form article composer | `/compose/articles` |
| Grok | `/i/grok` |
| Premium and verified organizations | `/i/premium`, `/i/verified-orgs-signup` |
| Money, creator monetization, subscriptions | `/i/money`, `/settings/monetization`, `/settings/manage_subscriptions` |
| Creator Studio | `/i/jf/creators/studio` |
| Community Notes | `/i/communitynotes` |
| Start a Space | `/i/spaces/start` |
| Account, security, privacy, notifications, accessibility | `/settings/account` and the relevant `/settings/...` page |
| Account information and archive | `/settings/your_twitter_data/account`, `/settings/download_your_data` |

X's **More** menu currently links Lists, Communities, Creator Studio, Community Notes, Business, Ads, Create your Space, and Settings. Open it through `[data-testid="AppTabBar_More_Menu"]`, use only the intended link, then press Escape and verify no visible `[role=menu]` remains if navigation did not close it.

## Extract structured X data

Prefer the rendered UI for small answers and a captured response from X's normal UI flow for larger virtualized datasets. Never replay a captured authenticated request.

### Posts and timelines

Treat each `article[data-testid="tweet"]` as one candidate post. Scope these fields to the same article:

- Author identity: `[data-testid="User-Name"]`, profile link, and verification indicator.
- Body: `[data-testid="tweetText"]`; expand only that card's `[data-testid="tweet-text-show-more-link"]` when needed.
- Canonical identity and time: the `a[href*="/status/"]` containing `time[datetime]`.
- Social context: `[data-testid="socialContext"]` for repost or recommendation context.
- Media and links: `[data-testid="tweetPhoto"]`, visible video, alt text, card links, and quoted-post content.
- Actions and counts: `[data-testid="reply"]`, `retweet` or `unretweet`, `like` or `unlike`, `bookmark` or `removeBookmark`, and the accessible **Share post** control.

Nested quoted posts can look like another post. Keep the outer canonical status and quoted canonical status as separate fields instead of combining authors or text. Identify ads or promoted cards from the same article and exclude them when the user asks for organic results.

Return records such as `{author, handle, verified, timestamp, text, canonicalUrl, replyCount, repostCount, likeCount, bookmarked, media, quotedPost, socialContext}`. Deduplicate by canonical status ID.

### People and relationships

Treat each `[data-testid="UserCell"]` as one candidate account. Extract its profile link, displayed name, handle, verification, description, relationship text such as **Follows you**, and current button state from the same cell. Follow-button test IDs contain an account ID and state suffix; use the full unique value only after matching the cell's visible identity.

Return `{name, handle, profileUrl, verified, followsYou, relationshipState, bio}` and deduplicate by lowercase handle. Ignore recommendation cells after the real requested list unless the user asks for suggestions.

### Search, notifications, bookmarks, lists, and communities

- Search through `[data-testid="SearchBox_Search_Input"]`, submit once, then use the visible Top, Latest, People, Media, or Lists tab that matches the request. Return canonical post or profile records, not search-page text blobs.
- Notifications expose All, Priority, and Mentions. Treat `[data-testid="notification"]` and embedded tweet articles as different record shapes; return actor, event type, time, target post, and unread evidence when visible.
- Bookmarks render normal tweet articles. Use the input with placeholder `Search Bookmarks` for local bookmark search. X exposes each post's publication time, not necessarily when the user bookmarked it; interpret “latest bookmarks” as the top records in X's current bookmark ordering and state that limitation unless a captured response provides a bookmark timestamp. Treat creating, renaming, moving to, or deleting a bookmark folder as separate mutations.
- Lists and Communities can contain recommendation cards beside owned or joined records. Resolve each canonical list/community link before reporting or acting.

## Scroll virtualized data without hammering X

Timelines, search results, followers, DMs, notifications, bookmarks, lists, and communities are virtualized or cursor-paginated.

1. Inspect the loaded records before scrolling.
2. Advance the actual scroll container by no more than one `clientHeight`.
3. Wait at least two seconds and for record count or network activity to settle.
4. Collect new canonical IDs or handles after each step because old nodes can leave the DOM.
5. Stop after two paced advances add no relevant records. Preserve and report partial results instead of restarting.

Never run a bottom-scroll loop, burst reloads, parallel pagination, or repeated carousel clicks.

## Create posts, replies, threads, polls, and media

The inline home composer currently exposes:

- Editor: `[data-testid="tweetTextarea_0"][aria-label="Post text"]`
- Submit: `[data-testid="tweetButtonInline"]`
- Media input: `input[data-testid="fileInput"]`
- GIF: `[data-testid="gifSearchButton"]`
- Image generation: `[data-testid="grokImgGen"]`
- Poll: `[data-testid="createPollButton"]`
- Schedule: `[data-testid="scheduleOption"]`
- Location: `[data-testid="geoButton"]`
- Content disclosure: `[data-testid="contentDisclosureButton"]`
- Reply audience: the scoped button whose accessible name states who can reply.

For draft-only work, return the draft without opening or filling X. For a requested post:

1. Verify the posting account and whether the task targets the inline composer, a modal composer, a reply, a quote, a Community, or a thread.
2. Replace the scoped editor with `type --selector` and reread its full `innerText`. Do not rely on `Meta+A` or the inserted-character count.
3. Keep X's displayed reply audience unless the user requested another. If the audience is missing or ambiguous, stop before posting.
4. Before opening an upload flow, verify every requested local attachment exists, is readable, and matches an accepted media type. Upload with `upload-file --files='["/absolute/path"]'` against the scoped `fileInput`; never use the singular `--file` option because Chrome Bridge can treat it as an output path. Verify every preview, order, processing state, and alt text when available.
5. For a poll, fill every visible choice and duration and verify the review state. For scheduling, verify timezone, date, time, and the scheduled-post confirmation. For a thread, verify every composer segment and its order before the final submission.
6. Click the scoped enabled Post or Reply button once. Verify the new canonical status by posting account and exact text, plus the successful create request when captured.

If the task stops before submission, clear the composer or close its visible dialog and verify no accidental draft or modal remains. X can retain unsent drafts.

### Schedule a post

The schedule control opens `/compose/post/schedule` in a visible dialog. Scope all fields and buttons to that dialog:

- Date: `input[name="Date"][type="date"]`
- Time: `input[name="Time picker"][type="time"]`
- Confirm schedule choice: `[data-testid="scheduledConfirmationPrimaryAction"]`
- Close without scheduling: `[data-testid="app-bar-close"]`
- Review queue: the scoped **Scheduled posts** button

Set the date and time with `type --selector` or `fill-form`, reread their exact values, and verify the timezone displayed by X against the user's requested timezone. Click **Confirm** once to return to the composer, then verify the composer shows the intended scheduled time before using its final Schedule action. A scheduled post has no public canonical status yet; verify success in **Scheduled posts** by exact text, media, date, time, timezone, and posting account. Do not apply the immediate-post canonical-status check until the scheduled item actually publishes.

## Operate on an existing post

Resolve the exact `article[data-testid="tweet"]` by canonical status URL, author, and text before touching its controls.

- **Reply**: click the article's `[data-testid="reply"]`, verify the referenced post in the visible composer, fill the reply, submit once, and verify the reply's canonical status.
- **Like or unlike**: inspect `like` versus `unlike`, click once, and require the opposite state plus the expected count change.
- **Repost or undo repost**: inspect `retweet` versus `unretweet`. Use the visible menu to distinguish Repost from Quote; do not choose one from the user's use of the generic word “share.” Verify the opposite state or new quote post.
- **Bookmark or remove bookmark**: inspect `bookmark` versus `removeBookmark`, click once, and verify the opposite state. Folder placement is a separate action.
- **Share**: scope **Share post** to the article, then distinguish Copy link, Send via Direct Message, and external sharing. Copying is local; sending is an account mutation.
- **More actions**: scope `[data-testid="caret"]` to the article. Delete, pin/unpin, highlight/unhighlight, mute, block, remove follower, report, change reply permissions, and embed are distinct actions. Execute only the exact requested item and close the menu if no action is taken.

Treat deletion, blocking, reporting, removing a follower, and changing reply permissions as destructive or high-impact. Verify the confirmation sheet's target and the post/profile state after completion.

## Read and send direct messages

X's current DM experience uses `/i/chat` and these stable test IDs:

- Shell and inbox: `dm-container`, `dm-inbox-panel`, `dm-inbox-header`
- Inbox filter: `dm-inbox-dropdown-trigger`
- Message requests: `dm-inbox-requests-button`
- New conversation: `dm-new-chat-button`
- Search entry point: `dm-search-bar`
- Conversation card: `[data-testid^="dm-conversation-item-"]`; its `a[role="option"]` opens `/i/chat/ID`
- Conversation panel and identity: `dm-conversation-panel`, `dm-conversation-header`, `dm-conversation-username`
- Message list: `dm-message-list-container`, `dm-message-list`
- Message record and body: `[data-testid^="message-"]` and `[data-testid^="message-text-"]`
- Composer: `dm-composer-form`, `dm-composer-textarea`, `dm-composer-file-input`
- Attachments and rich input: `dm-composer-attachment-button`, `dm-composer-gif-button`, `dm-composer-emoji-button`, `dm-composer-voice-button`

To list conversations, remain in the inbox and return participant, latest snippet, visible time, request/unread state, and canonical conversation identity. Do not print the dynamic conversation IDs. Opening an unread card can mark it read; open it only when the request requires full contents. When the user requests summaries without a message depth, summarize at most the latest five rendered messages per selected conversation and do not load older history.

To read a conversation, verify `dm-conversation-username` and its profile link, then extract message records from `dm-message-list` in DOM order. Associate each `message-text-ID` with its owning `message-ID`, visible media/reactions, and date separators. Current outgoing bubbles use the right-side `bg-chat-accent` treatment while incoming bubbles use the left-side `bg-gray-50` treatment; confirm direction from both position and styling. If exact timestamps are absent from rendered DOM, use the captured normal chat response instead of inventing them.

Load older messages by moving `dm-message-list` toward its top one viewport at a time. Deduplicate dynamic message IDs and stop after two advances add no messages.

To send:

1. Find or create the exact conversation and verify the recipient in `dm-conversation-header`.
2. Fill `textarea[data-testid="dm-composer-textarea"]`, then reread its full value.
3. Upload requested files through `dm-composer-file-input` with `--files` and verify the preview.
4. After content exists, resolve the visible enabled send control inside `dm-composer-form`; do not press Enter blindly if no explicit send control or behavior is grounded.
5. Send once and verify a new outgoing `message-ID` with the exact body and attachment state, plus the successful request when available.

Voice notes, calls, disappearing-message options, conversation deletion, blocking, and reporting are distinct high-impact actions. Never infer one from a generic “message them” request.

## Manage follows, followers, and verified follow-backs

For verified follow-backs, use `/HANDLE/verified_followers` and require all three signals in the same `[data-testid="UserCell"]`:

1. The page is X's **Verified Followers** view.
2. The cell says **Follows you**.
3. The cell button says **Follow back**.

Exclude **Following**, **Pending**, and generic **Follow** suggestions without **Follows you**.

For an approved follow:

1. Activate the tab and recheck the exact cell identity and current button state.
2. Start a capture filtered to `friendships/create` without bodies.
3. Click the unique scoped follow button once, wait at least three seconds, and verify **Following** in the same cell.
4. Require HTTP 200 from `POST /i/api/1.1/friendships/create.json` when captured, and read `x-rate-limit-limit`, `x-rate-limit-remaining`, and `x-rate-limit-reset`.
5. Continue through the approved set only while the target states remain correct and X reports capacity.

For “every” or “all” follow-back requests, completion requires one final paced rescan of the requested Verified Followers view from its start. Apply the same three qualifying signals and require zero remaining **Follow back** cells after deduplication. If qualifying accounts remain, continue only while the original authorization and rate-limit capacity still hold; otherwise report the remaining handles and stop reason.

For unfollow, remove follower, mute, block, or unblock, distinguish the requested relationship operation and verify any visible confirmation sheet. Never click a cell again while it already shows the requested end state.

## Manage lists, communities, profile, and settings

- **Lists**: distinguish viewing, creating, editing, deleting, pinning, adding/removing a member, and following/unfollowing a list. Verify the exact list ID, owner, privacy, and member before mutation.
- **Communities**: distinguish discovering, joining, requesting membership, leaving, posting within, inviting, and moderator actions. Verify the Community ID and role; a Community post is not a normal profile-only post.
- **Profile**: read `UserName`, `UserDescription`, `UserProfileHeader_Items`, `UserLocation`, `UserUrl`, `UserBirthdate`, and `UserJoinDate`. Open `editProfileButton` only for an edit request, change only named fields, save once, and verify the public profile.
- **Settings**: route to the owning `/settings/...` page. Read every current value in the scoped form before changing one. Treat password, email/phone, two-factor authentication, connected apps, session revocation, privacy, content visibility, notification delivery, archive requests, and account deactivation as separate operations.
- **Archive**: `/settings/download_your_data` can require authentication and starts an external archive workflow. Request it only when asked and report X's stated preparation or delivery behavior.

Premium purchases, subscriptions, payouts, Money transfers, ads, business verification, monetization enrollment, and revenue settings can create financial or legal consequences. Inspect and summarize freely, but require an unambiguous exact request before submitting, purchasing, transferring, enrolling, or changing payout details.

## Work with Spaces, articles, Creator Studio, and Community Notes

- **Spaces**: distinguish starting, scheduling, joining, speaking, inviting, recording, and ending. Verify title, schedule, recording state, and host account. Starting or ending a Space is an external action.
- **Articles**: use `/compose/articles`; distinguish drafting, previewing, publishing, editing, and deleting. Verify title, body, cover media, audience, and canonical article after publishing.
- **Creator Studio**: use `/i/jf/creators/studio` for content or analytics tasks. Treat bulk publishing or scheduling as a batch mutation and verify each item.
- **Community Notes**: use `/i/communitynotes`; distinguish reading notes, rating, writing, and submitting. Submission affects the public system and requires an exact request.

## Inspect X API traffic safely

Capture around one necessary UI navigation or action and filter to `/i/api/`, `/graphql/`, or the narrow observed endpoint family. X GraphQL paths usually expose operation names such as timeline, search, followers, bookmarks, notifications, or user posts; discover the current operation name from the live request instead of assuming a stale endpoint.

Use `network tail` to choose the relevant successful request and `network get-body` while the capture remains attached. Summarize sanitized method, endpoint family or GraphQL operation, status, variables shape, response record shape, cursor presence, rate-limit headers, and record count. Prefer captured response data for large reads; never reproduce a write by replaying the authenticated request.

Do not print or retain authorization headers, cookies, CSRF tokens, client transaction IDs, DM IDs, raw user IDs, cursor values, or signed-in URLs. Write raw captures only to a temporary absolute path, extract the requested result, stop the capture, and move raw files to Trash.

## Pace and stop safely

- Perform mutations one at a time with at least three seconds between them; never run parallel account mutations.
- Stop before another mutation on HTTP 429, `x-rate-limit-remaining: 0`, a rate-limit warning, non-2xx mutation, authentication change, account lock, challenge, or ambiguous result.
- Do not provoke a limit, bypass a challenge, solve an account checkpoint automatically, or replay requests to accelerate work.
- Treat a click receipt as input delivery, not proof. Verify the scoped UI end state and the successful request when available.
- If a capture is missing but the UI changed, do not click again. Passively recheck and compare the next successful request before deciding the state is ambiguous.

## Clean up and report

Close every menu, sheet, and dialog opened only for discovery. Stop captures and CDP sessions, clear emulation, and run `chrome-bridge status`. Restore the user's original active tab and scroll position when practical; leave existing X tabs open and close only temporary tabs.

For reads, return the requested structured records and the number inspected, deduplicated, and omitted. For mutations, report the exact target and action, UI confirmation, network confirmation when available, last observed rate-limit count and reset time, ambiguous states, and the exact reason for stopping.
