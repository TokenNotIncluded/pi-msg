# Output and wake-up measurements

## Same-task token comparison

Measured with the project's real MSG CLI in a new disposable offline account.
Fixture: one task containing 40 deterministic lines (5759 UTF-8 bytes). No production
messages, credentials or identity were used. Tokenizer: `cl100k_base`.

- Ordinary local CLI send response: **1137 tokens**.
- Adapter compact receipt: **17 tokens**.
- Ordinary full inbox read: **1290 tokens**.
- Adapter one-item summary inbox: **86 tokens**.
- Baseline send echo + receiver inbox body: **2427 tokens**.
- Adapter receipt + summary + one explicit full-body read: **1244 tokens**.
- Same-task reduction: **48.74%**, without deleting the original body.

Reproduce from this repository:

```sh
uv run --with tiktoken python scripts/measure.py --msg /absolute/path/to/msg
```

The receipt/summary/read texts use the documented adapter JSON output shape;
the raw send/inbox texts are captured from actual CLI operations. Counts exclude
tool schemas, system prompts and transport envelopes. They are exact for this
encoding and fixture, **not a claim about every provider's tokenizer or real-world
team workload**. Budgets are UTF-8 bytes, not a guessed byte-to-token ratio.

## Event coalescing

`tests/extension.test.ts` ingests **100 messages**, 90 ordinary progress notices
and 10 actionable result notices. It records **one** Pi `sendMessage` call with
`deliverAs: "followUp"`, `triggerTurn: true`; progress causes zero additional model
wake-ups. The wake references work IDs and fixed posts, never the private bodies.

`tests/transport.test.ts` disconnects a synthetic listener after its initial
subscription, injects a message without a live hint, and reconnects. Reconciliation
recovers it from the mailbox with the same durable independent cursor; stopping
cancels the listener and retry timer. A real offline CLI test verifies event arrival,
local compact send receipt, same-ID retry deduplication, and journal crash recovery.

The deterministic tests exercise the Pi extension API with a mock runtime; they
are not proof of a production 100-worker load run. The actual runtime delegates
busy/idle scheduling to Pi's native follow-up mechanism. Server-native push and
server-wide claim leases are not implemented by this adapter.
