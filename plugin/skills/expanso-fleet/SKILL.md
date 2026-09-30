---
name: expanso-fleet
description: Answer questions about Expanso nodes, jobs, executions, and logs with the read-only Expanso Fleet tools.
---

# Expanso Fleet

Use these tools to explain the state of an Expanso workspace. They only read;
nothing here can deploy, stop, rerun, or change a job or node. If the user
asks for a change, say it is not available in this plugin yet and describe
what they would do in Expanso Cloud.

- Overview: `fleet.open` shows the Fleet view. `list_nodes`, `list_jobs`, and
  `recent_errors` answer questions without the view.
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
