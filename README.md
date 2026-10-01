# Expanso Fleet for ChatGPT

See and control your Expanso fleet from ChatGPT: dashboards, jobs, pipelines,
and nodes.

Expanso Fleet is a ChatGPT plugin built on the
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
and [OpenAI MCP Extensions](https://github.com/openai/mcp-extensions). It
adds:

- **A Fleet view in the ChatGPT sidebar.** Nodes online, jobs by state, jobs
  that need attention, recent failed or degraded executions, and offline
  nodes for your active workspace, plus every job and every node grouped by
  health with filters and search.
- **Dashboards.** Nodes reporting and CPU over the last 30 minutes,
  executions placed, finished, and failed per hour over the last day, the
  jobs failing most, and a detail page for every node and job.
- **Fleets.** Your connected workspaces, which one is active, when each key
  expires, and a status summary for the active one, with Switch, Connect, and
  Reconnect inline.
- **Fleet control.** Deploy and edit jobs and pipelines, stop, rerun,
  delete, and roll back jobs, pause and resume rollouts, and remove nodes.
  Every change is previewed first and ChatGPT asks you to confirm it.
- **`@job` and `@node` mentions.** Type `@` in the composer to pick a job or
  node, then ask "why is this degraded?".
- **Tools** for nodes, jobs, executions with their state history, recent
  errors, and a bounded snapshot of recent job logs.

## How it works

```text
ChatGPT ──OAuth 2.1 + PKCE──▶ Expanso Fleet service (Cloudflare Worker)
   │                              │  /authorize   linking page
   │                              │  /oauth/*     tokens, client registration
   └──MCP (streamable HTTP)─────▶ │  /mcp         tools, Fleet app
                                  │
                                  ├─▶ Expanso Cloud   POST /api/v1/auth/token
                                  └─▶ your workspace  GET  /api/v1/{nodes,jobs,executions,…}
                                                      PUT/POST/DELETE  jobs, nodes
                                                      WS   /api/v1/jobs/{id}/logs
```

The service is a standalone Cloudflare Worker. It is both the MCP server and
the OAuth authorization server that ChatGPT signs in through:

1. When you connect the plugin, ChatGPT opens the service's sign-in page.
2. You paste an Expanso API key and one workspace endpoint. The service
   exchanges the key with Expanso Cloud, confirms the workspace accepts it,
   then seals the key with AES-256-GCM (a key held as a Worker secret) and
   caches it for that workspace. The OAuth grant holds only who you are.
3. ChatGPT receives an access token for this service only. The Expanso API
   key never reaches ChatGPT, the plugin package, plugin settings, logs, or
   tool results.
4. On each tool call the service exchanges the active workspace's key for a
   one-hour Expanso token and calls only that workspace.

### Workspaces and keys

Expanso Fleet reads one workspace at a time, with one key.

- **One cached key per workspace.** Each workspace you connect keeps its own
  sealed key, bound to your account and that workspace.
- **Switching never revokes.** `switch_workspace` (or the Active workspace
  setting) changes which cached workspace is read. The other keys stay
  cached.
- **Connecting another workspace.** `add_workspace` returns a one-time link,
  valid for ten minutes, to a page where you paste a key and one endpoint.
  The page only accepts a key for the same Expanso user and organization.
  The new workspace becomes active.
- **Unused connections expire.** Your cached workspaces expire together after
  30 days without use. Use extends that, at most once every 12 hours.
- **Disconnect** deletes a workspace's cached key. Expanso Cloud cannot revoke
  keys for Expanso Fleet yet, so revoke the key on the workspace's Keys page.
- **Expired or revoked keys.** When Expanso Cloud stops accepting a key, the
  workspace is marked for reconnecting, and tools and the Fleet view offer one
  Reconnect link. Tools also warn when a key expires within seven days.

Workspace endpoints must be Expanso hosts (by default `*.expanso.io`), so the
service cannot be pointed at other hosts.

Logs come from Expanso's existing live log stream. The service replays a
recent window, stops after at most 500 lines, 64 KB, or 10 seconds, and closes
the stream. The model only ever sees that snapshot.

## What is manual until Expanso Cloud adds it

| Today                                                                                          | Planned                                                                                         |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Sign-in is API-key linking on this service's page.                                             | "Sign in with Expanso" through MCP-compatible OAuth in Cloud.                                   |
| You type one workspace endpoint per connection (Expanso Cloud: your workspace, then Endpoint). | Pick the organization and workspace from a list.                                                |
| You create and paste a key for each workspace.                                                 | Cloud issues and rotates a key per connection (expanso-io/expanso-cloud#1967).                  |
| Disconnect deletes the cached key; you revoke the key on the workspace's Keys page.            | Disconnect revokes the key in Cloud.                                                            |
| Logs are a capped read of the live stream.                                                     | A bounded log snapshot endpoint with cursors.                                                   |
| The key button opens Expanso Cloud; you open your workspace, then Keys.                        | Link straight to the workspace's Keys page.                                                     |
| The Fleets view shows your connected workspaces, with status for the active one.               | Every workspace you can reach, with status for each from Cloud (expanso-io/expanso-cloud#1967). |

The key you paste has full access to its workspace, and Expanso Fleet uses
it to make the changes you confirm. It stays sealed on the service. Revoke it
in Expanso Cloud to cut off access.

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
4. Onboarding confirms your active workspace and opens the Fleet view.
5. Ask in plain words, or type `@Expanso` to aim a question at the plugin:
   "What jobs do I have on the network?", "Which nodes are healthy and which
   are not?", "What is failing right now, and why?". Type `@` and pick a job
   or node to ask about that one item.

**ChatGPT on the web, as a connector.** Turn on Developer mode (Settings,
Security and login), open <https://chatgpt.com/plugins>, choose the plus
button, and enter `https://<service>/mcp` with OAuth. The tools and Fleet view
work the same way; the onboarding skill is only in the plugin package.

## Tools

Tools that read:

| Tool              | What it returns                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `fleet.open`      | The Fleet view (sidebar entry point).                                   |
| `fleet_overview`  | Every job and node: counts first (healthy vs not), then items by state. |
| `fleet_dashboard` | Health over time, executions and failures per hour, per-node load.      |
| `node_dashboard`  | One node: CPU, memory, and disk over 30 minutes, and its executions.    |
| `job_dashboard`   | One job: state on every node, failures per hour, history, versions.     |
| `list_nodes`      | Nodes with connectivity, labels, and resource usage.                    |
| `get_node`        | One node and the executions placed on it.                               |
| `list_jobs`       | Jobs with state; `degraded` is filtered locally.                        |
| `get_job`         | One job with its executions and history.                                |
| `get_job_spec`    | A job's spec as YAML, credentials shown as `[redacted]`.                |
| `list_executions` | Executions for a job or node, by state.                                 |
| `get_execution`   | One execution with its state transitions and failure messages.          |
| `recent_errors`   | The latest failed, degraded, or lost executions, with history.          |
| `get_job_logs`    | A bounded log snapshot for a job from one node.                         |
| `preview_change`  | A preview of any change below; changes nothing (see below).             |
| `get_profile`     | The linked Expanso account, for telling connections apart.              |
| `list_workspaces` | Connected workspaces, which one is active, and key expiry.              |

Tools that change only this plugin's own records, never Expanso:

| Tool                   | What it does                                                           |
| ---------------------- | ---------------------------------------------------------------------- |
| `switch_workspace`     | Make another connected workspace active; nothing is revoked.           |
| `add_workspace`        | A one-time link to connect or reconnect a workspace.                   |
| `disconnect_workspace` | Delete a workspace's cached key.                                       |
| `settings.*`           | Read or change `activeWorkspaceId` (a plugin preference, not Expanso). |

Tools that change the fleet. ChatGPT asks you to confirm each one; the
destructive ones are marked so ChatGPT says they cannot be undone. These
tools and `preview_change` need the `fleet` scope; a connection made with the
read-only plugin (`fleet:read`) gets the read tools only, so reconnect it to
make changes.

| Tool             | Expanso API call                                         | Destructive                   |
| ---------------- | -------------------------------------------------------- | ----------------------------- |
| `deploy_job`     | `PUT /jobs` (create or update by name), `PUT /jobs/{id}` | Yes (overwrites a job's spec) |
| `stop_job`       | `POST /jobs/{id}/stop`                                   | Yes                           |
| `rerun_job`      | `PUT /jobs/{id}/rerun`                                   | No                            |
| `delete_job`     | `DELETE /jobs/{id}`                                      | Yes                           |
| `rollback_job`   | `POST /jobs/{id}/rollback`                               | Yes                           |
| `pause_rollout`  | `POST /jobs/{id}/rollout/pause`                          | No                            |
| `resume_rollout` | `POST /jobs/{id}/rollout/resume`                         | No                            |
| `delete_node`    | `DELETE /nodes/{id}`                                     | Yes                           |

### How a change is confirmed

1. `preview_change` validates the change with the workspace (a dry run for
   deploys and rollbacks) and returns a preview: the job or node by name, the
   connected nodes it reaches, a diff for edits, and any warnings. It changes
   nothing.
2. The preview's `next.arguments` carry that summary, target nodes, and diff,
   plus a token that signs them for this account for 10 minutes. ChatGPT
   shows those arguments when it asks you to confirm.
3. The write tool runs only when its arguments match the signed preview, and
   refuses an edit or rollback if the job changed after the preview. It also
   refuses when another workspace became active after the preview.

Specs shown in chat hide values under credential-looking keys (password,
token, key, secret, connection string, and similar) and URLs with embedded
passwords. Leave `[redacted]` in an edited spec to keep the current value.
A credential is kept only when the component holding it (an input, output,
processor, cache, or resource; outside `config`, the top-level field) is
otherwise unchanged, so a kept secret never follows a changed URL, broker, or
topic. To change anything else in that component, put its real credentials
in the spec. Edits to other components keep their credentials. In a list
(broker outputs, processors, resources), each item is matched to its current
one by `name` or `label`, by being the only item of its type, or by position.
Otherwise the preview refuses and asks you to restate the value or add a
label. The Fleet view's buttons use the same previews and show them before you
confirm.

Not available, because the Expanso API has no endpoint for them: setting
node labels (nodes report their own), draining or cordoning a node, and
approving or rejecting nodes. Per-pipeline throughput in messages or bytes is
not readable with an API key, so dashboards count executions instead.

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
