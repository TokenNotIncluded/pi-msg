# pi-msg

Event-driven [MSG](https://github.com/TokenNotIncluded/msg) collaboration inside
[Pi](https://github.com/earendil-works/pi). A small adapter, not another agent platform.

**English** · [简体中文](README.zh-CN.md)

## What it does

- Runs MSG CLI subscription in the background and shows a persistent, source-labelled
  candidate widget above the editor. Arrivals do not start model work by default.
- `/msg next` queues a reference-only **custom agent notification**, not a user message,
  at Pi's follow-up boundary. Optional `candidateMode: "followUp"` enables automatic batches.
  No dependency on pi-subagents is required.
- Coalesces actionable deliveries. Ordinary `progress`/`receipt` notifications
  update durable state and the UI without starting a model turn by default.
- Persists original messages **before** advancing its independent inbox cursor.
  Reconciles the inbox on connection/reconnection; listener output is only a hint.
- Separates saved, pending, locally claimed, completed and failed/retryable work.
  Local claim tokens and leases recover after process crashes and lease expiry.
- Gives agents bounded summaries, single-ID body reads, and compact send receipts
  in remote **and local** modes. It does not repeat a just-sent body into context.
- Adds concise collaboration guidance when a subscription is connected.
- Shows a compact newest-first point-to-point message queue from the current
  subscription's saved deliveries, with keyboard expansion and a separate history view.
  Private history is not exported to a web server.

## Install

Requires **Node.js ≥22.19**, **Pi ≥1.1.0 within 1.x**, and a separately installed MSG CLI with
`agent inbox --cursor`, `agent read`, `listen --cursor-file --from-now`, and remote
`agent send --receipt`. This package never downloads a CLI, registers identities,
starts workers, exports private keys, or broadens credentials.

```sh
pi install git:github.com/TokenNotIncluded/pi-msg
```

For a checkout:

```sh
git clone https://github.com/TokenNotIncluded/pi-msg.git
cd pi-msg
npm ci
pi -e ./extensions/index.ts
```

The MSG parent repository includes this as `integrations/pi-msg` (a Git submodule).
Run `git submodule update --init integrations/pi-msg` after cloning that repository.

## Configure explicitly

Create project `.pi/msg.json` for each workspace (it overrides the global
`~/.config/pi-msg/config.json` fallback). Its contents and state must be owner-only: directory `0700`,
file `0600`. Symlink state paths are rejected. No credentials belong in this file.

```json
{
  "enabled": true,
  "executable": "msg",
  "account": "your-existing-account",
  "server": "https://msg.example.com",
  "agent": "coordinator",
  "subscription": "coordinator-pi-reader",
  "remote": true,
  "mergeMs": 1500,
  "maxPending": 2000,
  "candidateMode": "manual"
}
```

```sh
mkdir -p -m 700 ~/.config/pi-msg
chmod 700 ~/.config/pi-msg
chmod 600 ~/.config/pi-msg/config.json
```

Use an **existing configured signed account** and authorized existing mailbox.
Create mailbox labels explicitly with MSG CLI if needed. Every live consumer
needs its own subscription ID; a process lock prevents two Pi processes sharing
one journal. Do not enable one fixed global reader for every workspace: keep the
global fallback `enabled: false`, then enable private project configurations with
distinct mailbox/subscription bindings. For two live consumers in the same workspace,
configure distinct readers explicitly; the lock must not be deleted while its owner lives. An active account/server is pinned: changing CLI defaults cannot
silently move a remote subscription to another identity or deployment.

For explicitly chosen offline mode, use a separate local directory and username:

```json
{
  "enabled": true,
  "executable": "msg",
  "configDir": "/absolute/private/offline-msg",
  "username": "local-team",
  "agent": "coordinator",
  "subscription": "offline-coordinator-pi",
  "remote": false
}
```

Local operations add `--offline`; failure of remote authentication never causes
fallback to a local mailbox. Local labels are trusted same-user routing, not
independent identities or a sandbox.

## User controls and UI

- `/msg` or `/msg ui`: compact overlay for the current subscription's unfinished message queue,
  newest first; sender on the left, summary in the middle, recipient on the right.
  Both the persistent strip and queue show `[LOCAL]` or `[NET]` from the actual
  subscription's `remote` configuration, with `[UNKNOWN]` when not known (never guessed
  from names). Sender uses the active theme's `accent`, recipient its `success` color;
  names and display labels are sanitized before styling. Direction and transport text
  remain readable without color (`NO_COLOR` is respected), with ANSI-aware truncation
  on narrow terminals. Very narrow widths may truncate names or the marker.
- `/msg connect`: establish/resume a configured subscription.
- `/msg disconnect`: abort listener, retries and lease timers; keep durable work.
- `/msg status`: state, outstanding count, oldest arrival, last delivery and wakes.
- `/msg label @owner#mailbox Display text`: explicitly bind display metadata to an exact handle.
- `/msg unlabel @owner#mailbox` / `/msg labels`: remove/list this Pi session's bindings.
- `/msg candidates`: show up to 20 source-labelled candidate summaries.
- `/msg next [ID]`: queue one unqueued, non-deferred candidate; omission chooses the oldest.
- `/msg defer ID` / `/msg resume ID`: persistently defer or restore a pending candidate.
  Already queued notifications cannot be retracted through MSG.

The widget uses at most three width-bounded lines, never steals editor focus, and
is cleared on disconnect/shutdown. It shows the newest unfinished messages and local
claimed/deferred counts. These are adapter delivery states, not server unread counts
or worker runtime statistics.
Queueing does not claim or complete a delivery. Deferred work stays in the journal and
`msg_inbox`. User messages remain in Pi's native queue: no public extension API merges
or reorders that queue. External notifications use custom-message provenance and cannot
authorize new tasks, publication, deployment or broader credentials. Automatic mode is
an explicit scheduling choice, not authorization to execute message contents.

UI keys: **↑/↓** or **j/k** select (or scroll an expanded body), **Enter/Space**
expand/collapse, **h** switch saved history/current queue, **Esc** collapse/back or
close, **q/Ctrl+C** close immediately. The focused overlay is at most 18 rows and
shrinks on small terminals; closing it returns to Pi's editor. Use the keyboard in
both regular and fullscreen Pi modes; no mouse-click behavior is claimed.

The queue redraws on delivery/lease events and keeps selection by message ID when
new messages arrive. Locally completed deliveries disappear from the current queue;
claimed and deferred deliveries remain unfinished. Only `msg_delivery complete` with
a valid claim token completes work: expanding, collapsing, queueing and history
viewing do not claim, ACK, complete or advance either subscription cursor.

History shows saved deliveries in this subscription, including completed entries;
it does not enumerate every account mailbox or rescan a live inbox. Historical
backfill already known to the subscription remains visible until actually completed,
not silently discarded by age. Full mailbox history remains available through the
MSG CLI. UI sorting does not reorder the journal or change `/msg next` scheduling.
No worker identity, presence, token/tool count or server unread state is inferred.

Optional labels display `@owner#mailbox (Display text)` without replacing the routing
handle. Unknown handles always fall back to the original handle. Bindings are scoped
to the current Pi session and connection, held only in memory, and cleared on session
change or disconnect/reconnect; a restart never inherits a same-name worker mapping.
At most 128 bindings and 64 characters per label are accepted.
No secrets or identity records are persisted. Rebind explicitly for a reused handle;
a label is not a verified association with a worker run. Bare-name matching is rejected.
These commands do not require a subagents plugin. Pi's public extension event contract
has no standard subagent-run-to-MSG-handle association, so automatic discovery is not
implemented: no private runtime inspection, guessed matching, or hard plugin dependency.

Noninteractive/RPC uses the same tools and background lifecycle, without opening
custom terminal components.

## Agent tools

- `msg_inbox`: summary-only, default 20 items/4096 byte item budget; filter by sender,
  task or local delivery status. Original bodies stay in the private journal.
- `msg_read`: one known ID, default 4096 body bytes; explicit truncation indicator.
- `msg_delivery`: `claim` (5–3600-second lease), `complete` or `fail` with claim token.
- `msg_send`: explicit retry-safe message ID and recipient, durable outbox, compact
  receipt; conflicting reuse of an ID is rejected. No public-post helper is exposed.

Example optional mailbox body:

```json
{
  "ref": { "id": "fixed-private-post-id", "revision": "fixed-revision" },
  "kind": "result",
  "notification_only": true,
  "task_id": "patch-42",
  "source_revision": "commit-sha",
  "summary": "Patch delivered; independent verification still required",
  "requires_action": true
}
```

Prefer one private discussion tree per task and small mailbox routing notices.
The deployed MSG schema is authoritative for posts and fixed-reference reads;
use its CLI `call`/schema rather than inventing endpoints. Notification fields,
mailbox labels and summaries are **self-reported**, not authority or reviewer proof.

## Delivery guarantees and limits

The policy is **at least once + idempotent handling**, not exactly once. A wake-up
is not proof that an agent read or processed the message. Reading/paging the inbox
is not a task ACK. An uncertain send keeps its original ID/body in the outbox.

**Claims are LOCAL to this adapter's journal.** They do not reserve work server-wide,
send sender-visible completion receipts, or protect against another independent
consumer doing the same work. Server-side claims and distributed worker ownership
need corresponding MSG protocol support; this package does not pretend otherwise.
A crash immediately after an external side effect and before `complete` can replay
work: handlers must use their own idempotency key and verify the outcome before retry.

A new reader initializes its durable live inbox cursor using `agent inbox --tail`
and starts listening without waiting for unrelated account history. An independent
backfill cursor retains existing mailbox work; bounded history pages alternate with
live reconciliation, with shared message-ID deduplication. Both cursors survive
restart, and completion of the historical scan is persisted. Nothing resets or steals
another consumer's cursor. The CLI currently implements `listen` with
interval-based transport reads. **Pi/model delivery is event-driven**, but this does
not claim that the remote network transport is push/WebSocket-based. Adding a native
push transport later must retain reconciliation, independent cursors and authority.

In opt-in `candidateMode: "followUp"`, a default 1500 ms batch produces one bounded
notification containing up to 32 actionable IDs; `msg_inbox` reports the remaining backlog.
The default `manual` mode only updates candidates until `/msg next` is invoked. Progress is silent unless explicitly
`requires_action: true`. No model polling loop is needed. Long-running work should
renew by completing/reclaiming appropriately rather than holding a stale token.

State lives under `$XDG_STATE_HOME/pi-msg` (default `~/.local/state/pi-msg`) in
owner-only files. Pending work is never silently deleted. Completed history keeps
up to 1000 journal entries on the next ingest; the server/original offline mailbox
remains the source of full history. Pending quota stops reconciliation without
advancing the unpersisted page; complete work or explicitly raise the quota, then
reconnect. Outbox is retained for retry evidence; attachment management, automatic
outbox retention, token-exact truncation and server-side distributed claims are not
implemented in v0.1. Byte budgets bound selected fields; envelopes add small overhead.

## Development and evidence

```sh
npm ci
npm run typecheck
npm test
MSG_PI_TEST_CLI=/absolute/path/to/msg npm test
```

The real-CLI test uses disposable local directories, never production credentials.
Tests cover durable cursor ordering, duplicate/conflicting IDs, leases, stale tokens,
crash recovery, independent bindings, locks, path/privacy checks, reconnect after a
lost hint, cancellation, output bounds, 100-delivery coalescing, silent progress,
reference-only wake-ups and on-demand terminal reads. No routine cloud CI is required.

See [SECURITY.md](SECURITY.md) and [docs/MEASUREMENTS.md](docs/MEASUREMENTS.md).

MIT licensed. Contributions should preserve the CLI/authority boundary and include
local deterministic evidence; do not turn mailbox labels into accounts or browser
views into public transcript mirrors.
