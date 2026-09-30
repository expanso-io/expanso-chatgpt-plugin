---
name: onboarding
description: Confirm the linked Expanso workspace, save the default, and open the Fleet view when the user sets up Expanso Fleet.
---

# Set up Expanso Fleet

The user linked Expanso when they connected this plugin: they pasted an
Expanso API key and one or more workspace endpoints on the Expanso Fleet
sign-in page. Never ask for an API key in chat. If the user offers one, tell
them to use the sign-in page instead, because keys must not be pasted into a
conversation.

1. Call `settings.read` with `{}`. It returns `defaultWorkspaceId`, the
   workspace the Fleet view and tools use.
2. If only one workspace is linked, confirm it by name and continue. If
   several are linked, ask once which one should be the default, then call
   `settings.update` with `{"set":{"defaultWorkspaceId":"<id>"}}`. Confirm the
   saved value from the tool's result; do not claim it was saved if the call
   fails.
3. Call `fleet.open` with `{}` to open the Fleet view.
4. Suggest a first question, for example "Which jobs need attention?" or
   mentioning a job with `@` and asking why it is degraded.

To link a different workspace or organization later, the user reconnects the
plugin from its settings and enters the new endpoint on the sign-in page.
