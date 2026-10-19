# `backend/gateway` — agent instructions

This repo is one project of the Tripsi workspace. If your tool did not load it already, read the
workspace rules in [`../../AGENTS.md`](../../AGENTS.md) before working: project map, git workflow
(`qa` base, no push/merge unless asked), project decisions and the rules for this kind of project.
Repo facts (purpose, run, verify, pitfalls) are in [`README.md`](README.md).

Several agents share this workspace. Claim the repo before editing and release it after
([`../../docs/architecture/agent-harness.md`](../../docs/architecture/agent-harness.md)):
`node ../../scripts/agent-coord.mjs claim backend/gateway --agent <your-tool>`.
