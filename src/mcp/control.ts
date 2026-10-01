import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectionRequired, type Account, type Session } from "../account.js";
import { SCOPES } from "../config.js";
import {
  applyChange,
  DESTRUCTIVE,
  PLAN_ACTIONS,
  previewChange,
  WRITE_ACTIONS,
  type ChangeContext,
  type WriteAction,
} from "./changes.js";
import { PlanError } from "./confirm.js";
import type { ChangePreview, ChangeResult } from "./contracts.js";
import { redactSpec, specYaml } from "./spec.js";

// Tools that change Expanso. Each write takes the arguments preview_change
// returned; ChatGPT shows them in its confirm step and the server refuses
// anything that differs from the signed preview.

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const confirmed = {
  workspaceId: z.string().describe("From the preview's next.arguments."),
  summary: z.string().describe("What will happen, from the preview."),
  confirmToken: z
    .string()
    .describe(
      "From the preview's next.arguments; proves the change was previewed.",
    ),
};

const reason = z.string().max(500).optional();

const jobTargets = {
  jobId: z.string(),
  jobName: z.string(),
  targetNodes: z
    .array(z.string())
    .describe("Nodes the change reaches, from the preview."),
  reason,
};

/** Input schema per write tool: exactly the fields its preview emits. */
const WRITE_INPUTS = {
  deploy_job: z.object({
    ...confirmed,
    operation: z.enum(["create", "update"]),
    jobName: z.string(),
    jobId: z.string().optional(),
    targetNodes: z.array(z.string()),
    diff: z.string().describe("Changes to the spec, from the preview."),
    spec: z.string().describe("The spec as previewed."),
    baseFingerprint: z.string().optional(),
  }),
  stop_job: z.object({ ...confirmed, ...jobTargets }),
  rerun_job: z.object({ ...confirmed, ...jobTargets }),
  pause_rollout: z.object({ ...confirmed, ...jobTargets }),
  resume_rollout: z.object({ ...confirmed, ...jobTargets }),
  delete_job: z.object({
    ...confirmed,
    ...jobTargets,
    force: z.boolean().optional(),
  }),
  rollback_job: z.object({
    ...confirmed,
    ...jobTargets,
    version: z.number().int(),
    diff: z.string(),
    baseFingerprint: z.string(),
  }),
  delete_node: z.object({
    ...confirmed,
    nodeId: z.string(),
    nodeName: z.string(),
    affectedJobs: z.array(z.string()),
    force: z.boolean().optional(),
    reason,
  }),
} satisfies Record<WriteAction, z.ZodType>;

const WRITE_TOOLS: Record<
  WriteAction,
  { title: string; description: string; invoking: string; invoked: string }
> = {
  deploy_job: {
    title: "Deploy job",
    description:
      "Create a job or pipeline, or update an existing one, exactly as previewed by preview_change (action deploy_job or deploy_pipeline). Running executions restart with the new spec.",
    invoking: "Deploying",
    invoked: "Deployed",
  },
  stop_job: {
    title: "Stop job",
    description:
      "Stop a job on every node it runs on, as previewed by preview_change. Its executions end; deploying it again restarts it.",
    invoking: "Stopping job",
    invoked: "Job stopped",
  },
  rerun_job: {
    title: "Rerun job",
    description:
      "Restart every execution of a job with its current spec as a new rollout, as previewed by preview_change.",
    invoking: "Restarting job",
    invoked: "Job restarted",
  },
  delete_job: {
    title: "Delete job",
    description:
      "Delete a job, as previewed by preview_change. A running job must be stopped first unless the preview used force.",
    invoking: "Deleting job",
    invoked: "Job deleted",
  },
  rollback_job: {
    title: "Roll back job",
    description:
      "Roll a job back to an earlier version, as previewed by preview_change.",
    invoking: "Rolling back",
    invoked: "Rolled back",
  },
  pause_rollout: {
    title: "Pause rollout",
    description:
      "Pause a job's rollout in progress, as previewed by preview_change.",
    invoking: "Pausing rollout",
    invoked: "Rollout paused",
  },
  resume_rollout: {
    title: "Resume rollout",
    description: "Resume a paused rollout, as previewed by preview_change.",
    invoking: "Resuming rollout",
    invoked: "Rollout resumed",
  },
  delete_node: {
    title: "Delete node",
    description:
      "Remove a node from the workspace, as previewed by preview_change. The node must enroll again to rejoin.",
    invoking: "Deleting node",
    invoked: "Node deleted",
  },
};

type StructuredContent = NonNullable<CallToolResult["structuredContent"]>;

type WriteInput = z.infer<(typeof WRITE_INPUTS)[WriteAction]>;

function result(structuredContent: StructuredContent, text: string) {
  return { content: [{ type: "text" as const, text }], structuredContent };
}

type ToolResult = ReturnType<typeof result>;

/** Answers a call that cannot reach a workspace, with the link that fixes it. */
export type ConnectionAnswer = (error: ConnectionRequired) => ToolResult;

/**
 * Runs work against the active workspace. A write passes the workspace its
 * preview was made for, and is refused when another workspace is active now.
 */
async function withWorkspace(
  account: Account,
  onConnectionRequired: ConnectionAnswer,
  previewedFor: string | undefined,
  work: (ctx: ChangeContext, session: Session) => Promise<ToolResult>,
): Promise<ToolResult> {
  let session: Session;

  try {
    session = await account.session();
  } catch (error) {
    if (error instanceof ConnectionRequired) return onConnectionRequired(error);

    throw error;
  }

  const active = session.workspace.workspaceId;

  if (previewedFor !== undefined && previewedFor !== active) {
    throw new PlanError(
      `This change was previewed for workspace ${previewedFor}, but the active workspace is now ${active}. Switch back to ${previewedFor}, or preview the change again in ${active}.`,
    );
  }

  return work(
    {
      client: session.client,
      workspaceId: active,
      consoleUrl: account.consoleUrl,
      sign: (plan) => account.signPlan(plan),
      verify: (token, plan) => account.verifyPlan(token, plan),
    },
    session,
  );
}

export function describePreview(preview: ChangePreview): string {
  const lines = [
    preview.destructive ? `DESTRUCTIVE: ${preview.summary}` : preview.summary,
  ];

  if (preview.targetNodes.count > 0 || preview.targetNodes.selector) {
    lines.push(
      `Nodes (${preview.targetNodes.count}${preview.targetNodes.more ? "+" : ""}): ${preview.targetNodes.names.join(", ") || "none"}${preview.targetNodes.selector ? `; selector ${preview.targetNodes.selector}` : ""}.`,
    );
  }

  if (preview.diff?.text) {
    lines.push("Diff:", preview.diff.text);

    if (preview.diff.truncated) lines.push("(diff truncated)");
  }

  for (const warning of preview.warnings) lines.push(`Warning: ${warning}`);

  lines.push(
    `To make this change, call ${preview.next.tool} with next.arguments exactly as given; ChatGPT asks the user to confirm first. Show the user this preview before calling it.`,
  );

  return lines.join("\n");
}

export function registerControlTools(
  server: McpServer,
  account: Account,
  scopes: readonly string[],
  onConnectionRequired: ConnectionAnswer,
) {
  server.registerTool(
    "get_job_spec",
    {
      title: "Get job spec",
      description:
        "Get a job's full spec as YAML, to edit it. Credentials are shown as [redacted]; leave them as [redacted] in an edited spec to keep the current values.",
      inputSchema: z.object({ jobId: z.string() }),
      annotations: readOnly,
    },
    ({ jobId }) =>
      withWorkspace(
        account,
        onConnectionRequired,
        undefined,
        async ({ client }) => {
          const job = await client.getJobSpec(jobId);
          const yaml = specYaml(redactSpec(job.spec));

          return result(
            { jobId: job.id, version: job.version, spec: yaml },
            yaml,
          );
        },
      ),
  );

  if (!scopes.includes(SCOPES.fleet)) return;

  server.registerTool(
    "preview_change",
    {
      title: "Preview a change",
      description: [
        "Preview any change to the Expanso fleet before making it. Nothing changes: the workspace validates the change (a dry run) and the preview names the job or node, the nodes it reaches, and a diff for edits. Show the preview to the user, then call the tool in next.tool with next.arguments.",
        "Actions: deploy_job (spec: a complete job spec as YAML or JSON; jobId to update a specific job, otherwise a job with the same name is updated or a new one created);",
        "deploy_pipeline (create: name, config as pipeline YAML, selector; edit: jobId plus any of config, selector, description, name);",
        "stop_job, rerun_job, pause_rollout, resume_rollout (jobId); delete_job (jobId, force to stop and delete a running job);",
        "rollback_job (jobId, version, default the previous version); delete_node (nodeId, force for a connected node).",
        "Node labels, drain, and approval cannot be changed through the Expanso API.",
      ].join(" "),
      inputSchema: z.object({
        action: z.enum(PLAN_ACTIONS),
        jobId: z.string().optional(),
        nodeId: z.string().optional(),
        spec: z.string().optional(),
        name: z.string().optional(),
        config: z.string().optional(),
        description: z.string().optional(),
        selector: z
          .object({
            matchLabels: z.record(z.string(), z.string()).optional(),
            matchIds: z.array(z.string()).optional(),
            matchExpressions: z
              .array(z.string())
              .optional()
              .describe('For example "region in (us-east,us-west)".'),
          })
          .optional()
          .describe("Which nodes run the pipeline. All parts must match."),
        version: z.number().int().optional(),
        force: z.boolean().optional(),
        reason,
      }),
      annotations: readOnly,
      _meta: {
        "openai/toolInvocation/invoking": "Previewing change",
        "openai/toolInvocation/invoked": "Preview ready",
      },
    },
    (request) =>
      withWorkspace(account, onConnectionRequired, undefined, async (ctx) => {
        const preview = await previewChange(ctx, request);

        return result({ ...preview }, describePreview(preview));
      }),
  );

  for (const action of WRITE_ACTIONS) {
    const tool = WRITE_TOOLS[action];

    server.registerTool(
      action,
      {
        title: tool.title,
        description: `${tool.description} Call only with next.arguments from preview_change, after the user has seen the preview.`,
        inputSchema: WRITE_INPUTS[action],
        annotations: {
          readOnlyHint: false,
          destructiveHint: DESTRUCTIVE[action],
          idempotentHint: false,
          openWorldHint: false,
        },
        _meta: {
          "openai/toolInvocation/invoking": tool.invoking,
          "openai/toolInvocation/invoked": tool.invoked,
        },
      },
      (input: WriteInput) =>
        withWorkspace(
          account,
          onConnectionRequired,
          input.workspaceId,
          async (ctx) => {
            const outcome: ChangeResult = await applyChange(ctx, action, input);

            const warnings = outcome.warnings.length
              ? `\nWarnings: ${outcome.warnings.join("; ")}`
              : "";

            return result({ ...outcome }, `${outcome.summary}${warnings}`);
          },
        ),
    );
  }
}
