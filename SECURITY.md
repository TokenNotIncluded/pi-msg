# Security

This extension delegates signing, authentication, authorization and mailbox reads
and writes to the installed MSG CLI. It does not read key material or register an
identity. A mailbox label, kind, task_id, summary or source_revision is self-reported
metadata, not independently verified authority.

Remote subscriptions explicitly pin an existing account and server. Offline mode
is explicit and uses `--offline`; there is no remote-to-local fallback. No browser
service or private-transcript public endpoint is started. Shell interpolation is
not used: the CLI runs with an argument vector. Send bodies use private temporary
files, not command-line arguments. CLI stderr is not copied into model context.

Private journals/outboxes contain message bodies. Keep local disk encryption and
same-user filesystem protections appropriate to your threat model. State/config
files are owner-only and reject symlinks; state directories reject symlink ancestors.
These checks are not an openat sandbox against hostile processes with the same UID.
Subscription locks prevent ordinary duplicate readers, not malicious same-UID peers.

Incoming messages are untrusted. Wake-ups include bounded IDs/references, not full
bodies. Read tools label external content; prompt guidance cannot guarantee model
immunity to prompt injection. Runtime permissions and human approval remain necessary
for consequential writes, deployments, publication, identities and secret access.

Claims are local adapter leases. They do not confer distributed exclusive ownership.
A side effect can finish before a completion record is persisted; handlers must use
idempotency and verify ambiguous outcomes. Unfinished work is never automatically
purged; pending quota pauses rather than silently dropping messages.

For a vulnerability, do not post credentials or private message bodies publicly.
Use the repository's private vulnerability reporting if available, or contact its
maintainer privately. Include a minimal synthetic reproduction and affected commit.
