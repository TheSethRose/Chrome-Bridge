---
name: linkedin-chrome-bridge
description: Retrieve LinkedIn data and operate the user's signed-in linkedin.com session through chrome-bridge. Use for feeds, search, profiles, posts, messages, notifications, connections, jobs, saved items, company pages, analytics, settings, archives, business tools, API traffic, or rate limits.
---

# LinkedIn Account Operations via Chrome Bridge

Use this as the task-oriented LinkedIn layer on top of [the base Chrome Bridge skill](../chrome-bridge/SKILL.md). Read only the base command or state references needed for the current operation. Use `chrome-bridge` as the only browser interface and operate the user's existing signed-in Chrome session.

## Interpret the request as an operation

Do the requested LinkedIn job instead of returning generic DOM or network observations.

- **Get, find, list, review, identify, or summarize**: retrieve useful records without posting, messaging, connecting, following, reacting, applying, or changing settings.
- **Draft a message, post, article, newsletter, recommendation, or profile change**: write the draft in the response. Put it into LinkedIn only when the user asks.
- **Send, publish, connect, accept, follow, react, repost, save, edit, recommend, apply, schedule, or delete**: an exact imperative request authorizes that exact action when the target, content, identity, and audience are unambiguous. Do not request duplicate confirmation.
- **Get my messages**: list or read the requested conversations. Opening an unread conversation can mark it read; inventory unread cards without opening them unless the request requires their contents.
- **Run my LinkedIn**: break the request into concrete operations and report results by person, conversation, post, notification, job, application, page, event, newsletter, or setting.

Ask only when a missing recipient, final content, attachment, posting identity, audience, schedule, application answer, destructive target, or other decision could materially change the action. An explicit batch size authorizes that set; if no size is stated, default to five mutations. Resolve and deduplicate the full target set before the first mutation, then continue through the approved set at a conservative pace unless a stop condition occurs.

## Ground the intended LinkedIn surface

1. Run `chrome-bridge status` and `chrome-bridge list-tabs`.
2. Select the exact `linkedin.com` tab with `--tab=ID`; inspect its URL and the smallest relevant visible state.
3. Reuse the user's current LinkedIn tab when that will not disrupt their work. Use one temporary background tab for multi-route discovery, then close it.
4. Activate the tab before real mouse or keyboard input. A background-tab click can report success without LinkedIn receiving the action.
5. Prefer stable routes, roles, accessible names, semantic classes, `data-testid`, and `data-view-name`. Scope every generic control to its owning card, thread, dialog, form, or admin surface.

## Map LinkedIn functionality to routes

Replace `HANDLE`, `ID`, and `QUERY` with identities resolved from links LinkedIn already rendered. Preserve the currently selected personal or Page identity unless the request names another.

| Functionality | Current route or surface |
|---|---|
| Home feed and personal post composer | `/feed/` and `/preload/sharebox/` |
| Global search | `/search/results/all/` through `input[data-testid="typeahead-input"]` |
| People and content search | `/search/results/people/` and `/search/results/content/` |
| Product search | `/search/results/products/` |
| Personal profile | `/in/me/` or `/in/HANDLE/` |
| Profile activity and owned posts | `/in/HANDLE/recent-activity/all/` |
| Post analytics | `/analytics/post-summary/urn:li:activity:ID/` |
| Messaging | `/messaging/` |
| Notifications | `/notifications/` |
| Network suggestions | `/mynetwork/grow/` |
| Invitations | `/mynetwork/invitation-manager/` |
| Connections | `/mynetwork/invite-connect/connections` |
| Following and followers | `/mynetwork/network-manager/people-follow/` |
| Followed Pages and newsletters | `/mynetwork/network-manager/company/` and `/mynetwork/network-manager/newsletters/` |
| Network catch-up | `/mynetwork/catch-up/all/` |
| Jobs, search results, and job detail | `/jobs/`, `/jobs/search-results/`, and `/jobs/view/ID` |
| Job preferences and tracker | `/jobs/preferences/` and `/jobs-tracker/` |
| Saved posts and learning | `/my-items/saved-posts/` and `/my-items/learning/` |
| Company Page administration | `/company/ID/admin/` |
| Job posting account | `/talent/job-management-redirect/` |
| Settings categories | `/mypreferences/d/categories/account` and the relevant category route |
| Official data archive | `/mypreferences/d/download-my-data` |
| Campaign Manager | `/campaignmanager/accounts/` |
| Services Marketplace | `/services/` |
| Talent Insights | `/insights/` |

LinkedIn's **Me** menu currently owns profile, activity, Settings & Privacy, help, language, Page administration, job-posting account, and sign-out links. **For Business** owns advertising, hiring, Talent Insights, Services Marketplace, Sales, and Admin Center entry points. Treat routes on `business.linkedin.com` and separate product dashboards as distinct applications: reuse the signed-in session, but reground the shell, selectors, account identity, and financial consequences after navigation.

## Extract structured LinkedIn data

Use the rendered UI for small answers and a captured response from a normal LinkedIn UI flow for larger virtualized datasets. Never replay an authenticated request.

### Feed posts and owned activity

On `/feed/`, scope work to `[data-testid=mainFeed]`; candidate cards are rendered `[role=listitem]` descendants whose visible text identifies a **Feed post**. On self activity, use `[data-view-name="feed-full-update"]`. Scope these fields to the same card:

- Author name, canonical `/in/HANDLE/` or `/company/ID/` link, verification indicator, and follow state.
- Relative or accessibility timestamp, audience, edited state, and canonical `/feed/update/ID` link when present.
- Full post body, expanding **… more** only inside that card.
- Media, document, poll, article, newsletter, event, job, or external-link preview metadata.
- Reaction, comment, and repost counts; owned posts may also expose impressions, **View analytics**, **Boost**, or boost eligibility.
- Sponsored or promoted state, which must remain distinct from organic content.

Deduplicate by canonical post URL or activity identity. For comments and reactions on the user's activity, use the available activity filter instead of inferring ownership from the feed.

### Profiles and people

Use `main#workspace` and locate sections by visible headings rather than generated hash classes. A profile record should include canonical profile URL, displayed name, verification, headline, location, relationship degree, current company or school, follower and connection counts when shown, **Follows you** evidence, **Open to** state, and the requested About, Featured, Activity, Experience, Education, Skills, Recommendations, Licenses & Certifications, Projects, Publications, Courses, Volunteering, Honors, Languages, Organizations, or Interests sections.

Use a section's own **Show all**, **See more**, or scoped link when content is collapsed. Do not infer a person's employer, skill, or relationship from another card on the page.

### Search

Use `input[data-testid="typeahead-input"]`, submit one query, and wait for the results route and list to settle. Prefer the owning vertical route or the visible result-type control. People search can expose relationship degree, current-company, past-company, location, and filters such as 1st, 2nd, 3rd+, and **Actively hiring**; content search can expose recency and network filters. Jobs, companies, schools, groups, events, courses, services, and products can appear as verticals when LinkedIn offers them for the query.

Return the query, active vertical, active filters, result name or title, canonical URL, result type, subtitle or headline, relationship state, and the evidence used to match. When the request names a current employer, require LinkedIn's **Current company** filter or equivalent current-position evidence inside each result; a keyword match or past-company association does not qualify. Searching can add to LinkedIn's search history; do not clear history unless asked.

### Notifications

On `/notifications/`, use rendered `article[data-view-name="notification-card-container"]` cards. Scope image, text, time, destination, `data-nt-card-index`, and unread evidence such as `aria-label="Unread notification."` to the same article. The current filters include **All**, **Jobs**, **My posts**, and **Mentions**.

List cards without clicking for a read-only inventory. Opening a notification may mark it read or navigate to a post, profile, job, or analytics page. The card's scoped `button[aria-label="Settings menu"]` can expose notification-setting mutations; do not use it during retrieval.

### Jobs and applications

Identify a job by title, company, location, canonical `/jobs/view/ID` URL, work arrangement, employment type, salary when shown, posting age, applicant count, promoted state, and apply method. Treat **Save**, **Dismiss**, alert creation, tracker movement, **Easy Apply**, external apply, and withdrawal as separate operations.

`/jobs-tracker/` currently separates **Saved**, **In Progress**, **Applied**, **Interview**, and **Archived**. Moving a job between tracker states records the user's workflow; it does not submit or withdraw an application.

### Saved items, learning, groups, events, and newsletters

Use `/my-items/saved-posts/` for saved posts and `/my-items/learning/` for learning items. Saved post results can expose `[data-view-name="search-entity-result-content-a-template"]` or `-b-template` plus a canonical `/feed/update/ID` link. Read and summarize without unsaving; use the post's scoped action menu only for an explicit unsave or other mutation.

For groups, events, newsletters, courses, and services, enter through the current search result, network manager, profile, or invitation link that owns the object. Record its canonical URL, owner or organizer, membership or subscription state, dates, and available role. Joining, leaving, subscribing, unsubscribing, RSVP changes, invitations, attendee messaging, course enrollment, and service-provider contact are distinct mutations.

## Read the inbox and messages

LinkedIn's current messaging route uses these semantic classes:

- Conversation list: `.msg-conversations-container__conversations-list`
- Conversation card: `.msg-conversation-listitem`
- Card target: `.msg-conversation-listitem__link`
- Participant: `.msg-conversation-listitem__participant-names`
- Card time: `.msg-conversation-listitem__time-stamp`
- Latest snippet: `.msg-conversation-card__message-snippet`
- Inbox search: `#search-conversations`
- Active participant profile: `.msg-thread__link-to-profile`
- Thread container: `.msg-s-message-list`
- Message event: `.msg-s-message-list__event`
- Message body: `.msg-s-event-listitem__body`
- Rendered sender profile: `.msg-s-message-group__profile-link`

To list conversations, inspect cards without clicking and return participant, card time, latest snippet, and unread or starred state. Scope every field to the same card. For unread inventory, do not open cards. If a summary requires opening multiple unread threads, first resolve and deduplicate the complete target card set because opening the first can reorder the unread list. Record each target's initial unread state, then report every conversation LinkedIn may have marked read. When the user asks for message contents and omits depth, default to the latest five rendered messages in each requested conversation.

To find a conversation, use `type --selector='#search-conversations'` with the person's name, wait for the list to settle, and match exact participant text. Clear the search when finished. Inspect loaded cards before moving the list one viewport at a time.

To read a thread:

1. Select the exact scoped card and wait for the thread.
2. Verify `.msg-thread__link-to-profile` against the intended participant.
3. Read `.msg-s-message-list__event` records in DOM order, collecting sender, direction, timestamp, body, reactions, and attachments. Associate grouped events without a repeated profile link with the most recent rendered sender group.
4. For older messages, move `.msg-s-message-list` toward its top by one `clientHeight`, wait at least two seconds, and deduplicate. Stop after two advances add no events.
5. Return records such as `{participant, direction, timestamp, body, attachments}` without thread IDs, cookies, or raw payloads.

## Draft or send a message

For draft-only work, return the draft without touching LinkedIn unless the user explicitly asks to place it in the composer.

For sending:

1. Open or search for the exact conversation and verify `.msg-thread__link-to-profile`.
2. Replace the editor through `.msg-form__contenteditable[aria-label="Write a message…"]` using `type --selector`, then reread its complete `innerText`.
3. Upload attachments through the same form's `input[type=file]` with `upload-file --files='["/absolute/path"]'`; verify every filename or preview.
4. Resolve the visible enabled **Send** button inside that `.msg-form`. Do not use **Open send options** unless the user requested an alternate send mode.
5. Click once and verify a new outgoing `.msg-s-message-list__event` with the exact body and attachments, plus the successful request when available.

If anything is wrong after typing, replace or clear the composer before leaving because unsent drafts can persist. Conversation deletion, blocking, reporting, InMail credit use, and paid message features require their own exact request.

## Create or manage content

The personal post entry point on `/feed/` is the visible anchor `[href="/preload/sharebox/"]` containing a descendant labeled **Start a post**.

1. For draft-only work, return the draft without opening the composer.
2. Open the entry point only for a request to place or publish content. Identify the one visible `[role=dialog]` by rendered rectangles because LinkedIn retains hidden dialogs in the DOM.
3. Scope the editor, identity, audience, media controls, scheduling controls, and final **Post** button to that dialog. Enter the exact text and reread the full editor content.
4. Preserve the displayed identity and audience when the request omits them. Stop if either is absent or ambiguous. Changing identity or audience is a distinct choice and may open another sheet.
5. Upload media through the visible dialog's `input[type=file]`; verify preview order, filename, alt text when available, and removal controls.
6. For document, poll, event, job, article, or newsletter content, inspect the current composer or owning product surface and verify every type-specific field before publishing.
7. Click the final scoped control once. Verify the dialog closed and the canonical published item appears under the intended personal profile or Company Page with the exact content. Confirm the successful request when available.

If the task stops before publishing, close every sheet or dialog opened for it and verify that none remains visible. Do not leave an accidental draft, overlay, or audience picker open.

For an existing post, scope Reaction, Comment, Repost, Send, Save, Follow, Boost, analytics, and the **more actions** menu to the intended card. Distinguish:

- Like from Celebrate, Support, Love, Insightful, and Funny, and each from removing a reaction.
- Comment from reply, edit comment, or delete comment.
- Repost from repost with thoughts and from undoing a repost.
- Save from unsave, Send in LinkedIn from copying or sharing an external link.
- Edit from delete, feature, boost, or change comment controls.

Verify the scoped state after one action. Public deletions, paid boosts, and irreversible moderation actions require exact targets and must never be inferred from “manage this post.”

## Manage the network and profile

On suggestion cards, buttons can expose `Invite NAME to connect` and `Remove NAME as a suggestion`. Scope the button to the card containing the same canonical profile, headline, and mutual-connection evidence. Treat connect with note, connect without note, accept, ignore, withdraw, follow, unfollow, remove connection, remove follower, and remove suggestion as different operations.

For an approved relationship action, recheck the person's profile URL and current state, click once, wait at least three seconds, and verify the exact end state such as **Pending**, **Message**, **Following**, accepted, or removed. Do not click a person again when the requested end state is already present.

For profile edits, open only the target section's scoped **Edit** control. Read every current field before changing the named fields, preserve unrelated values, save once, and verify the public profile. Treat **Open to**, services, contact info, verification, profile photo, background image, headline, About, Experience, Education, Skills, recommendations, and visibility as separate forms or workflows.

Writing, requesting, accepting, dismissing, or revising a recommendation affects another member and requires an exact person and text. Endorsing a skill is a public relationship mutation; reading endorsements is not.

## Manage jobs and applications

Use user-provided application answers and inspect every application step. A direct request to apply authorizes that specified application, but stop before submission for a missing required answer, ambiguous eligibility response, unexpected resume or profile change, required assessment, external account creation, payment, or a review screen that differs materially from the request. If stopping leaves Easy Apply open and closing it presents **Save application** versus **Discard**, do not choose either without direction; leave that decision prompt untouched, report it, and report any autosaved draft state LinkedIn already shows.

For Easy Apply, verify the job, company, selected resume, contact details, every answer, consent, and final review. Upload only the user-specified resume or cover letter. Click the final submit control once and require LinkedIn's submission confirmation. For external applications, reground on the destination site and do not treat LinkedIn authorization as permission to create an external account or accept unrelated terms.

Job alerts, preference edits, dismissals, saves, tracker changes, applications, and withdrawals are independent. Never withdraw, archive, or modify a submitted application incidentally.

## Operate Company Pages and business products

On `/company/ID/admin/`, verify the Page name, Page ID, current admin role, and posting identity before any mutation. Distinguish Page posts, comments, messages, events, jobs, followers, invitations, analytics, lead forms, admins, settings, and paid promotion. A request about the user's personal account does not authorize posting as a Page, and a Page post request does not authorize a personal post.

Use the current Page admin navigation rather than guessing an admin subroute. For edits, read all fields in the owning form, change only named fields, save once, and verify the public Page. For Page content, follow the same draft, identity, audience, media, publish, and verification rules as personal content.

Campaign Manager, Sales, Recruiter or hiring, Talent Insights, Premium, Services Marketplace, and Admin Center can affect ad spend, contracts, applicant data, credits, billing, or organization access. Inspect and summarize freely, but require an unambiguous exact request before purchasing, launching a campaign, posting a paid job, contacting a lead or candidate, changing billing, granting admin access, or submitting business details.

## Manage settings, privacy, security, and archives

Settings & Privacy currently separates these category routes:

- `/mypreferences/d/categories/account`
- `/mypreferences/d/categories/sign-in-and-security`
- `/mypreferences/d/categories/profile-visibility`
- `/mypreferences/d/categories/privacy`
- `/mypreferences/d/categories/ads`
- `/mypreferences/d/categories/notifications`

Route to the owning category, read the current value in its scoped form, and change only the requested setting. Treat email and phone, password, passkeys, two-factor authentication, active sessions, connected accounts, profile visibility, discovery, data use, advertising data, notification channels, blocked members, feed preferences, language, verification, hibernation, account closure, and sign-out as separate operations. Password/security changes, session revocation, hibernation, account closure, and sign-out require exact requests and visible final-state verification.

Use `/mypreferences/d/download-my-data` for LinkedIn's official archive. Select the full archive or only categories currently offered, click **Request archive** only when asked, and verify LinkedIn accepted the request. Report its stated preparation and delivery behavior; never expose the downloaded archive or its private contents beyond the requested output.

## Inspect LinkedIn API traffic safely

Discover the current request family from the owning route. LinkedIn currently uses `/flagship-web/rsc-action/actions/`, `/rest/`, and on some surfaces `/voyager/api/`.

Start a narrow capture before one necessary normal UI navigation or action. Use `network tail` to choose the relevant successful request and `network get-body` while the capture remains attached. Summarize sanitized method, path family, status, payload shape, response shape, record count, pagination evidence, and rate-limit or checkpoint evidence. Prefer captured responses for large reads; never reproduce a write by replaying the authenticated request.

Do not print or retain cookies, CSRF values, authorization headers, tracking IDs, message or conversation IDs, application answers, private profile data, cursor values, or signed-in URLs. Write raw captures only to a temporary absolute path, extract the requested safe result, stop the capture, and move raw files to Trash.

## Pace and stop safely

LinkedIn's desktop shell often scrolls inside `main#workspace`, while messaging uses its own list and thread containers. Resolve the actual scroll container because `window.scrollBy` can do nothing.

- Inspect the loaded DOM and retained traffic before causing pagination.
- Advance at most one `clientHeight`, wait at least two seconds, and recount deduplicated records. Stop after two advances add no relevant records.
- Never run tight scroll loops, burst clicks, repeated reloads, parallel browser mutations, repeated carousel actions, or captured-request replays.
- Perform mutations one at a time with at least three seconds between them.
- Stop before another mutation on HTTP 429, a rate-limit warning, checkpoint, CAPTCHA, authentication change, account restriction, repeated non-2xx response, unexpected dialog, or ambiguous result.
- Do not provoke a limit, bypass a challenge, or repeat a click because a capture was missing. Passively recheck the scoped UI first.
- Treat click success as input delivery, not proof. Verify the exact scoped UI state and successful request when available.

For a large read, return the partial count when the bounded scrolling rule stops. For “all” or “every” relationship mutations, completion requires one final paced rescan from the beginning of the requested view and zero remaining qualifying records; otherwise report remaining targets and the exact stop reason.

## Clean up and report

Close every menu, sheet, and dialog opened only for the task unless closing would trigger an unapproved save, discard, publish, submit, or delete decision. Leave such a decision prompt untouched and report it. Stop captures and CDP sessions, clear emulation, and run `chrome-bridge status`. Restore the user's original active tab and scroll position when practical; leave existing LinkedIn tabs open and close only temporary tabs.

For reads, return the requested structured records and the number inspected, deduplicated, and omitted. For mutations, report the exact identity, target, submitted content or action, UI confirmation, network confirmation when available, rate-limit or checkpoint evidence, ambiguous states, and the exact reason for stopping.
