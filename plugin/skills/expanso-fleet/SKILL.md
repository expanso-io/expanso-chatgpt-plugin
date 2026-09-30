---
name: expanso-fleet
description: Answer questions about Expanso nodes, jobs, pipelines, executions, and logs, show fleet dashboards, and make changes the user confirms, with the Expanso Fleet tools.
---

# Expanso Fleet

Use these tools to explain and change an Expanso workspace.

## Reading

- Questions about what exists or what is healthy ("what jobs do I have?",
  "which nodes are healthy vs not?", "what is failing?"): call
  `fleet_overview`. Answer with the counts first (total, healthy, not
  healthy), then list the items that are not healthy by name, grouped by
  state. Offer the full list or the Fleet view when there are many.
- "How is the fleet doing?", "what changed today?": call `fleet_dashboard`.
  It covers nodes reporting and CPU for the last 30 minutes and executions
  placed, finished, and failed per hour for the last day. Say plainly that
  pipeline throughput in messages or bytes is not available here.
- One node in depth: `node_dashboard`. One job in depth, or before a
  rollback: `job_dashboard` (its versions are listed newest first).
- "Which fleets do I have?": `list_fleets`. To make another connected fleet
  the default, call `settings.update` with its `defaultWorkspaceId`.
- `fleet.open` shows the Fleet view, with Dashboard, Jobs, Nodes, and Fleets
  tabs.
- A mentioned job (`expanso://workspaces/<workspace>/jobs/<id>`): call
  `get_job` first. For "why is it degraded or failing", read the failing
  executions with `get_execution` (its history carries the failure messages),
  then `get_job_logs` for recent lines from an affected node. Quote the
  specific error lines and timestamps you relied on.
- A mentioned node: call `get_node`. Online means the node's connection state
  is `connected`; `lost` or `disconnected` nodes are offline.
- Logs are a bounded snapshot, not a live stream. If the snapshot is
  truncated or empty, say so and suggest a shorter lookback or a specific
  node instead of guessing.
- Pass `workspaceId` only when the user names another linked workspace.

## Changing the fleet

Every change is two calls, and the user sees the preview before anything
happens.

1. Call `preview_change` with the action. It changes nothing.
2. Show the user the preview: the summary, the nodes it reaches, the diff for
   edits, and any warnings. Say "destructive" when the preview is.
3. When the user wants it, call the tool named in `next.tool` with
   `next.arguments` exactly as returned. Do not edit, drop, or add fields;
   the call is refused if they differ. ChatGPT asks the user to confirm.
4. Report the result. If the call says the preview expired or the job
   changed, preview again.

Actions:

- New pipeline: `deploy_pipeline` with `name`, `config` (the pipeline YAML:
  inputs, processors, outputs), and `selector` (which nodes; `matchLabels`,
  `matchIds`, `matchExpressions`, all must match). Ask which nodes if the
  user did not say.
- Edit a pipeline: `deploy_pipeline` with `jobId` and only the parts that
  change (`config`, `selector`, `description`, or `name`). For larger edits,
  read the spec with `get_job_spec`, change it, and preview `deploy_job` with
  `jobId` and the whole `spec`. Values shown as `[redacted]` are credentials:
  leave them as `[redacted]` to keep them. Never ask the user to paste a
  credential into chat.
- Any job from a full spec (YAML or JSON): `deploy_job` with `spec`. A job
  with the same name is updated; otherwise one is created.
- `stop_job`, `rerun_job`, `pause_rollout`, `resume_rollout`: `jobId`.
- `delete_job`: `jobId`. A running job must be stopped first; pass
  `force: true` only when the user asked to stop and delete in one step.
- `rollback_job`: `jobId`, and `version` (default the previous version).
- `delete_node`: `nodeId`. Only lost or disconnected nodes, unless the user
  explicitly wants a connected node removed (`force: true`).

The Expanso API cannot set node labels, drain or cordon a node, or approve
nodes. Say so instead of attempting it; labels come from each node's own
configuration.
