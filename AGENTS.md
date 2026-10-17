# Agent integration work

When a user asks to configure this project's Agent capabilities, follow
`docs/AGENT_INTEGRATION.md`. Install the client, register the `ima-qa` STDIO MCP,
and install the single `skills/ima-qa` entry from `packages/ima-qa-client` using
its `setup --agent codex` command. Do not manually register the references as
separate skills. The display name is `ima 知识库助手`.

Reuse an existing Provider; missing Provider setup follows
`docs/AGENT_DEPLOYMENT.md`. Keep credentials in private config, pair ordinary
and internal tokens under one Provider application, preserve clientId, and
never probe by asking a real question unless the user's task calls for it.

For client development, install dependencies in both repository root and
`packages/ima-qa-client`, then run the relevant tests. Keep durable-task
idempotency, explicit cancellation, and upstream session ownership intact.
