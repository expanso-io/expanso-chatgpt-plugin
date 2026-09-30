# Expanso Fleet for ChatGPT

See your Expanso nodes, jobs, executions, and pipeline health from ChatGPT.

Expanso Fleet is a ChatGPT plugin built on the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
and [OpenAI MCP Extensions](https://github.com/openai/mcp-extensions). It
adds:

- **A Fleet view in the ChatGPT sidebar.** Nodes online, jobs by state, jobs
  that need attention, recent failed or degraded executions, and offline
  nodes for your default workspace.
- **`@job` and `@node` mentions.** Type `@` in the composer to pick a job or
  node, then ask "why is this degraded?".
- **Read-only tools** for nodes, jobs, executions with their state history,
  recent errors, and a bounded snapshot of recent job logs.

Phase 1 is read-only. The plugin cannot deploy, stop, rerun, or change
anything in Expanso.

## How it works

```text
ChatGPT ──OAuth 2.1 + PKCE──▶ Expanso Fleet service (Cloudflare Worker)
   │                              │  /authorize   linking page
   │                              │  /oauth/*     tokens, client registration
   └──MCP (streamable HTTP)─────▶ │  /mcp         read-only tools, Fleet app
                                  │
                                  ├─▶ Expanso Cloud   POST /api/v1/auth/token
                                  └─▶ your workspace  GET  /api/v1/{nodes,jobs,executions}
                                                      WS   /api/v1/jobs/{id}/logs
```

The service is a standalone Cloudflare Worker. It is both the MCP server and
the OAuth authorization server that ChatGPT signs in through:

1. When you connect the plugin, ChatGPT opens the service's sign-in page.
2. You paste an Expanso API key and your workspace endpoint once. The service
   exchanges the key with Expanso Cloud, confirms each workspace accepts it,
   then seals the key with AES-256-GCM (a key held as a Worker secret) inside
   the OAuth grant, which the OAuth library also encrypts at rest.
3. ChatGPT receives an access token for this service only. The Expanso API
   key never reaches ChatGPT, the plugin package, plugin settings, logs, or
   tool results.
4. On each tool call the service exchanges the key for a one-hour Expanso
   token and reads only from the linked workspaces.

Workspace endpoints must be Expanso hosts (by default `*.expanso.io`), so the
service cannot be pointed at other hosts.

Logs come from Expanso's existing live log stream. The service replays a
recent window, stops after at most 500 lines, 64 KB, or 10 seconds, and closes
the stream. The model only ever sees that snapshot.

## What is manual until Expanso Cloud adds it

| Today                                                                                                | Planned                                                       |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Sign-in is API-key linking on this service's page.                                                   | "Sign in with Expanso" through MCP-compatible OAuth in Cloud. |
| You type the workspace endpoint (Expanso Cloud: your workspace, then Endpoint). Several are allowed. | Pick the organization and workspace from a list.              |
| Logs are a capped read of the live stream.                                                           | A bounded log snapshot endpoint with cursors.                 |
| The key button opens Expanso Cloud; you open your workspace, then Keys.                              | Link straight to the workspace's Keys page.                   |

Expanso Cloud API keys have no read-only scope yet: the key you paste has full
access to its workspace. Expanso Fleet only reads, and the key stays sealed on
the service.

These are tracked in expanso-io/expanso-cloud. The plugin stays a personal
install until "Sign in with Expanso" ships; it is not in the public plugin
directory.

## Install for yourself

You need the service URL of a deployed instance (see
[Deploy your own](#deploy-your-own)) and an Expanso API key (`exp_ak_…`) for
the organization you want to see.

**ChatGPT desktop, as a plugin (recommended).** This includes the onboarding
flow and the Fleet sidebar entry.

```sh
npm ci
npm run build:plugin -- --mcp-url https://<service>/mcp --install
```

This builds the plugin into `dist/plugin/expanso-fleet`, copies it to
`~/.codex/plugins/expanso-fleet`, and adds it to your personal marketplace in
`~/.agents/plugins/marketplace.json` (existing entries are kept). Then:

1. Restart the ChatGPT desktop app.
2. Open the Plugins Directory, choose your personal marketplace, and install
   **Expanso Fleet**.
3. On the sign-in page, choose **Get my key from Expanso Cloud**. In Cloud,
   open your workspace, then **Keys**, and create a key named for this
   connection with no expiry. Paste it and the workspace's **Endpoint** into
   the page, then choose **Connect**. If something is wrong, the page says
   which value failed and why.
4. Onboarding confirms your default workspace and opens the Fleet view.
5. In a chat, type `@` and pick a job, then ask why it is degraded.

**ChatGPT on the web, as a connector.** Turn on Developer mode (Settings,
Security and login), open <https://chatgpt.com/plugins>, choose the plus
button, and enter `https://<service>/mcp` with OAuth. The tools and Fleet view
work the same way; the onboarding skill is only in the plugin package.

## Tools

| Tool              | What it returns                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `fleet.open`      | The Fleet view (sidebar entry point).                                   |
| `list_nodes`      | Nodes with connectivity, labels, and resource usage.                    |
| `get_node`        | One node and the executions placed on it.                               |
| `list_jobs`       | Jobs with state; `degraded` is filtered locally.                        |
| `get_job`         | One job with its executions and history.                                |
| `list_executions` | Executions for a job or node, by state.                                 |
| `get_execution`   | One execution with its state transitions and failure messages.          |
| `recent_errors`   | The latest failed, degraded, or lost executions, with history.          |
| `get_job_logs`    | A bounded log snapshot for a job from one node.                         |
| `get_profile`     | The linked Expanso account, for telling connections apart.              |
| `settings.*`      | Read or change `defaultWorkspaceId` (a plugin preference, not Expanso). |

Mentions resolve to `expanso://workspaces/{workspace}/jobs/{id}` and
`expanso://workspaces/{workspace}/nodes/{id}` resources.

## Develop

Requires Node.js 24.

```sh
npm ci
cp .dev.vars.example .dev.vars   # then set LINK_ENCRYPTION_KEY
npm run dev                      # http://localhost:8787
npm run check                    # lint, format, typecheck, tests
```

Tests use recorded Expanso API responses in `test/fixtures` and never call a
live service. The end-to-end suite runs dynamic client registration, PKCE,
the sign-in page, the token endpoint, and authenticated MCP calls against
local KV.

| Path       | Contents                                                   |
| ---------- | ---------------------------------------------------------- |
| `src/`     | The Worker: OAuth sign-in, MCP server, Expanso API client. |
| `app/`     | The Fleet view (React MCP App), built into one HTML file.  |
| `plugin/`  | Plugin manifest, onboarding and usage skills, icon.        |
| `scripts/` | App embedding, plugin build and install, pilot deployment. |

## Deploy your own

The service runs on Cloudflare Workers, separate from Expanso's production
infrastructure. Deployment uses only credentials in this directory:

1. Copy `.env.pilot.example` to `.env.pilot` and run `chmod 600 .env.pilot`.
   Add a Cloudflare API token limited to one account with **Workers Scripts:
   Edit** and **Workers KV Storage: Edit**, and that account's ID.
2. Run `npm run deploy:pilot`.

The script builds the Worker, creates a KV namespace, deploys to
`workers.dev`, and sets a newly generated encryption key as a Worker secret
without printing it. Account IDs, namespace IDs, and the service URL stay in
gitignored files (`wrangler.pilot.jsonc`, `.pilot/`).

## License

[Apache-2.0](LICENSE)
