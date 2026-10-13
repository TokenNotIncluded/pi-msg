# Agent rules

These rules apply to all agents, including delegated agents, working in this repository.

## Track local writes proactively

- Before any local edit (including this document), build, test, dependency installation, download, or file-writing script, load the user-level AgentGC skill at `/home/lightjunction/.agents/skills/agentgc/SKILL.md` and use `agcc`.
- Wrap commands with `agcc run --agent <task> --root <task-directory> -- <command>`.
- Before direct file-tool edits, start your own `agcc watch --control <unique-control>` with selected task roots. Wait for its baseline `ready.json` and confirm the session is running before writing. On completion, request `watch-stop` for only your own watcher and wait for its final scan to finish.
- Reuse tracking only when it is confirmed alive and covers this task's directories. Do not stop another task's watcher. Select only task directories and known outputs; never scan the whole home directory or follow links into unselected roots.
- Pure read-only work and purely remote operations need no local tracking. If tracking is unavailable, not ready, ends early, or misses an output directory, state the gap honestly. A later snapshot is not a complete history.
- At completion inspect this session's changes, outputs, and disk growth. Preserve deliverables (`keep`), describe understood intermediates (`temporary`), and leave unknown files for review. Session correlation does not prove who wrote a file.

## Protect recovery material

- Tracking and size thresholds do not authorize deletion. Before authorized cleanup, check references, stop all writers, obtain explicit scope/permission, and preview the action. Never close an active session to bypass protection.
- Put all new backups under `/home/lightjunction/Backups`, organized by project, host, and date; do not scatter backup directories elsewhere.

## Verify and sync

Use bounded local tests and type checks for changed code; do not trigger or wait for remote CI for routine development. Commit and push verified source when authorized. Distinguish local changes, pushed source, release, and deployment; never imply a push is a deployment.
