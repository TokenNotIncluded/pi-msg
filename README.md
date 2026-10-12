# pi-msg

Event-driven [MSG](https://github.com/TokenNotIncluded/msg) collaboration inside
[Pi](https://github.com/earendil-works/pi). A small adapter, not another agent platform.

**English** · [简体中文](README.zh-CN.md)

## What it does

- Runs MSG CLI subscription in the background. Idle Pi receives a wake-up; busy
  Pi receives a queued follow-up at Pi's safe boundary, not an interrupting tool call.
- Coalesces actionable deliveries. Ordinary `progress`/`receipt` notifications
  update durable state and the UI without starting a model turn by default.
- Persists original messages **before** advancing its independent inbox cursor.
  Reconciles the inbox on connection/reconnection; listener output is only a hint.
- Separates saved, pending, locally claimed, completed and failed/retryable work.
  Local claim tokens and leases recover after process crashes and lease expiry.
- Gives agents bounded summaries, single-ID body reads, and compact send receipts
  in remote **and local** modes. It does not repeat a just-sent body into context.
- Adds concise collaboration guidance when a subscription is connected.
- Provides an interactive terminal channel browser, fixed-message reader and live
  asynchronous delivery board. Private history is not exported to a web server.

## Install

Requires **Node.js ≥22.19**, **Pi 1.1.x**, and a separately installed MSG CLI with
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
  "maxPending": 2000
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

- `/msg` or `/msg ui`: authorized channel list → message summaries → selected body.
- `/msg connect`: establish/resume a configured subscription.
- `/msg disconnect`: abort listener, retries and lease timers; keep durable work.
- `/msg status`: state, outstanding count, oldest arrival, last delivery and wakes.

UI keys: **↑/↓** or **j/k**, **Enter** to select/read, **Tab** for the async flow
board, **n** for the next history page, **r** to refresh history, **Esc** to go back.
The board and listener status redraw on delivery/lease events; browsing history
uses a separate in-memory pagination cursor, never the delivery cursor. Viewing a
body does not claim, acknowledge or complete it. Noninteractive/RPC use has the
same tools and background lifecycle, without opening the terminal browser.

Mailbox channels let a person inspect coordinator and worker histories under the
CLI's existing authority. The flow board describes this subscription's durable
local deliveries, not every worker's actual runtime or independently proven work.
It marks `source_revision` and attempts when provided. No public presence is inferred.

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

A new reader initializes the listener at the live tail, then reconciles its mailbox.
Its first inbox reconciliation reads existing mailbox work once; subsequent reads
resume the durable opaque inbox cursor. The CLI currently implements `listen` with
interval-based transport reads. **Pi/model delivery is event-driven**, but this does
not claim that the remote network transport is push/WebSocket-based. Adding a native
push transport later must retain reconciliation, independent cursors and authority.

A default 1500 ms batch produces one bounded wake containing up to 32 actionable
IDs; `msg_inbox` reports the remaining backlog. Progress is silent unless explicitly
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
