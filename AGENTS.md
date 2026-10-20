# Agent rules

These rules apply to all agents, including delegated agents, working in this repository.

## Protect recovery material

- Before authorized cleanup, check references, stop all writers, obtain explicit scope/permission, and preview the action.
- Put all new backups under `/home/lightjunction/Backups`, organized by project, host, and date; do not scatter backup directories elsewhere.

## Verify and sync

Use bounded local tests and type checks for changed code; do not trigger or wait for remote CI for routine development. Commit and push verified source when authorized. Distinguish local changes, pushed source, release, and deployment; never imply a push is a deployment.
