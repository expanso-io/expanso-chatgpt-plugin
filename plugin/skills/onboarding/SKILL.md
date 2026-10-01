---
name: onboarding
description: Confirm the active Expanso workspace and open the Fleet view when the user sets up Expanso Fleet.
---

# Set up Expanso Fleet

The user connected Expanso when they installed this plugin: they pasted an
Expanso API key and one workspace endpoint on the Expanso Fleet sign-in page.
Never ask for an API key in chat. If the user offers one, tell them to use the
connection page instead, because keys must not be pasted into a conversation.

1. Call `list_workspaces` with `{}`. It lists the connected workspaces and
   marks the active one, which every tool reads.
2. Confirm the active workspace by name. If the user wants another one that
   is already connected, call `switch_workspace` with its `workspaceId`. If
   it is not connected yet, call `add_workspace` and give the user the link;
   it works once, for ten minutes. Confirm the result from the tool; do not
   claim a switch or connection happened if the call fails.
3. Call `fleet.open` with `{}` to open the Fleet view.
4. Suggest a first question, for example "Which jobs need attention?" or
   mentioning a job with `@` and asking why it is degraded.

If a tool says the workspace needs connecting or reconnecting, pass on the
link it returns. Switching workspaces never revokes a key; only
`disconnect_workspace` removes one, and then the user revokes the key on the
workspace's Keys page in Expanso Cloud.
