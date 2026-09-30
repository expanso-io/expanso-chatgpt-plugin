import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMentions, createSettings } from "@openai/mcp-extensions/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Account } from "../account.js";
import { SCOPES } from "../config.js";
import {
  readLogSnapshot,
  LOG_LIMITS,
  type OpenLogSocket,
} from "../cloud/logs.js";
import type { ExecutionState } from "../cloud/types.js";
import { describeFleet, fleetSummary } from "./fleet.js";
import { searchMentions } from "./mentions.js";
import {
  ERROR_EXECUTION_STATES,
  executionView,
  historyView,
  jobView,
  nodeView,
} from "./views.js";

export const FLEET_APP_URI = "ui://expanso-fleet/app-v1";

export const SERVER_VERSION = "0.1.0";

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const EXECUTION_STATES = [
  "pending",
  "starting",
  "validating",
  "running",
  "degraded",
  "completed",
  "failed",
  "lost",
  "stopping",
  "stopped",
] as const satisfies readonly ExecutionState[];

const workspaceArg = z
  .string()
  .optional()
  .describe("Workspace ID. Defaults to the workspace saved in settings.");

const limitArg = (max: number, fallback: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`Default ${fallback}, max ${max}.`);

export interface ServerOptions {
  account: Account;
  /** Scopes granted to this connection. */
  scopes: readonly string[];
  appHtml: string;
  iconSvg: string;
  openLogSocket?: OpenLogSocket;
}

type StructuredContent = NonNullable<CallToolResult["structuredContent"]>;

function result(structuredContent: StructuredContent, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

/**
 * Builds the MCP server for one request. Every tool here is read-only: this
 * phase registers no tool that changes anything in Expanso.
 */
export function buildServer(options: ServerOptions): McpServer {
  const { account } = options;

  const icon = {
    src: `data:image/svg+xml,${encodeURIComponent(options.iconSvg)}`,
    mimeType: "image/svg+xml",
    sizes: ["any"],
  };

  const server = new McpServer({
    name: "expanso-fleet",
    title: "Expanso Fleet",
    version: SERVER_VERSION,
    icons: [icon],
  });

  // The grant schema guarantees at least one linked workspace.
  const [firstWorkspace, ...otherWorkspaces] = account.workspaces;

  const workspaceIds: [string, ...string[]] = [
    firstWorkspace.workspaceId,
    ...otherWorkspaces.map((item) => item.workspaceId),
  ];

  createSettings(server).register({
    fields: {
      defaultWorkspaceId: {
        schema: z.enum(workspaceIds),
        title: "Default workspace",
        description:
          "The Expanso workspace the Fleet view and tools use unless another is named.",
      },
    },
    read: () => account.settings(),
    update: (set) => account.updateSettings(set),
  });

  createMentions(server).setHandler(async ({ query }) => {
    const workspace = await account.workspace();
    const client = await account.client(workspace.workspaceId);

    return {
      items: await searchMentions(client, workspace.workspaceId, query),
    };
  });

  const openFleet = async () => {
    const workspace = await account.workspace();

    const summary = await fleetSummary(
      await account.client(workspace.workspaceId),
      workspace,
    );

    return result({ ...summary }, describeFleet(summary));
  };

  server.registerTool(
    "fleet.open",
    {
      title: "Expanso Fleet",
      description:
        "Open the Expanso Fleet view: node connectivity, job health, and recent failed or degraded executions for the default workspace.",
      inputSchema: z.object({}),
      annotations: readOnly,
      _meta: {
        ui: { resourceUri: FLEET_APP_URI },
        "openai/ui": { entrypoints: [{ type: "global" }] },
        "openai/iconStyle": "monochrome",
      },
    },
    openFleet,
  );

  server.registerTool(
    "fleet.summary",
    {
      title: "Refresh Fleet summary",
      inputSchema: z.object({}),
      annotations: readOnly,
      _meta: { ui: { visibility: ["app"] } },
    },
    openFleet,
  );

  server.registerTool(
    "list_nodes",
    {
      title: "List nodes",
      description:
        "List edge nodes in an Expanso workspace with connectivity (online means connected), labels, and resource usage.",
      inputSchema: z.object({
        workspaceId: workspaceArg,
        prefix: z.string().optional().describe("Node ID or name prefix."),
        onlyOffline: z
          .boolean()
          .optional()
          .describe("Only nodes that are not connected."),
        limit: limitArg(100, 50),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, prefix, onlyOffline, limit }) => {
      const client = await account.client(workspaceId);
      const page = await client.listNodes({ prefix, limit: limit ?? 50 });

      const nodes = (page.items ?? [])
        .map(nodeView)
        .filter((node) => !onlyOffline || !node.online);

      return result(
        { nodes, more: Boolean(page.next_token) },
        `${nodes.length} nodes (${nodes.filter((node) => node.online).length} online).`,
      );
    },
  );

  server.registerTool(
    "get_node",
    {
      title: "Get node",
      description: "Get one edge node and the executions placed on it.",
      inputSchema: z.object({ workspaceId: workspaceArg, nodeId: z.string() }),
      annotations: readOnly,
    },
    async ({ workspaceId, nodeId }) => {
      const client = await account.client(workspaceId);

      const [node, executions] = await Promise.all([
        client.getNode(nodeId),
        client.listExecutions({ nodeIds: [nodeId], limit: 20 }),
      ]);

      const view = nodeView(node);

      return result(
        { node: view, executions: (executions.items ?? []).map(executionView) },
        `Node ${view.name ?? view.id} is ${view.connectionState}.`,
      );
    },
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description:
        "List jobs (pipelines and other workloads) in an Expanso workspace, newest updates first, with state such as running, degraded, or failed.",
      inputSchema: z.object({
        workspaceId: workspaceArg,
        prefix: z.string().optional().describe("Job ID or name prefix."),
        state: z
          .string()
          .optional()
          .describe("Only jobs in this state, for example degraded or failed."),
        limit: limitArg(200, 50),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, prefix, state, limit }) => {
      const client = await account.client(workspaceId);
      // "degraded" is not a server-side filter, so state is applied here.
      const page = await client.listJobs({ prefix, limit: limit ?? 50 });

      const jobs = (page.items ?? [])
        .map(jobView)
        .filter((job) => !state || job.state === state);

      return result(
        { jobs, more: Boolean(page.next_token) },
        `${jobs.length} jobs.`,
      );
    },
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description:
        "Get one job with its current executions and recent history. Use this first to explain why a job is degraded or failing.",
      inputSchema: z.object({ workspaceId: workspaceArg, jobId: z.string() }),
      annotations: readOnly,
    },
    async ({ workspaceId, jobId }) => {
      const client = await account.client(workspaceId);

      const [job, executions, history] = await Promise.all([
        client.getJob(jobId),
        client.jobExecutions(jobId, { limit: 20 }),
        client.jobHistory(jobId, { limit: 20 }),
      ]);

      const view = jobView(job);

      return result(
        {
          job: view,
          executions: (executions.items ?? []).map(executionView),
          history: (history.items ?? []).map(historyView),
        },
        `Job ${view.name ?? view.id} is ${view.state}${view.message ? `: ${view.message}` : ""}.`,
      );
    },
  );

  server.registerTool(
    "list_executions",
    {
      title: "List executions",
      description:
        "List job executions, optionally for one job or node and filtered by state.",
      inputSchema: z.object({
        workspaceId: workspaceArg,
        jobId: z.string().optional(),
        nodeId: z.string().optional(),
        states: z.array(z.enum(EXECUTION_STATES)).optional(),
        limit: limitArg(100, 25),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, jobId, nodeId, states, limit }) => {
      const client = await account.client(workspaceId);

      const page = await client.listExecutions({
        jobId,
        nodeIds: nodeId ? [nodeId] : undefined,
        states,
        limit: limit ?? 25,
      });

      const executions = (page.items ?? []).map(executionView);

      return result(
        { executions, more: Boolean(page.next_token) },
        `${executions.length} executions.`,
      );
    },
  );

  server.registerTool(
    "get_execution",
    {
      title: "Get execution",
      description:
        "Get one execution with its state transition history and failure messages.",
      inputSchema: z.object({
        workspaceId: workspaceArg,
        executionId: z.string(),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, executionId }) => {
      const client = await account.client(workspaceId);

      const [execution, history] = await Promise.all([
        client.getExecution(executionId),
        client.executionHistory(executionId, { limit: 50 }),
      ]);

      const view = executionView(execution);

      return result(
        { execution: view, history: (history.items ?? []).map(historyView) },
        `Execution ${view.id} is ${view.state}${view.message ? `: ${view.message}` : ""}.`,
      );
    },
  );

  server.registerTool(
    "recent_errors",
    {
      title: "Recent errors",
      description:
        "List the most recently updated failed, degraded, or lost executions, with state history for the newest few.",
      inputSchema: z.object({
        workspaceId: workspaceArg,
        limit: limitArg(20, 10),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, limit }) => {
      const client = await account.client(workspaceId);

      const page = await client.listExecutions({
        states: [...ERROR_EXECUTION_STATES],
        limit: limit ?? 10,
      });

      const executions = (page.items ?? []).map(executionView);

      const withHistory = await Promise.all(
        executions.slice(0, 3).map(async (execution) => ({
          executionId: execution.id,
          history: (
            (await client.executionHistory(execution.id, { limit: 10 }))
              .items ?? []
          ).map(historyView),
        })),
      );

      return result(
        { executions, histories: withHistory },
        executions.length === 0
          ? "No failed, degraded, or lost executions."
          : `${executions.length} recent failed, degraded, or lost executions.`,
      );
    },
  );

  server.registerTool(
    "get_job_logs",
    {
      title: "Get job logs",
      description: `Read a bounded snapshot of recent log lines for a job from one node: at most ${LOG_LIMITS.maxLines} lines, ${LOG_LIMITS.maxSeconds} seconds of collection, and ${LOG_LIMITS.maxLookbackMinutes} minutes of lookback.`,
      inputSchema: z.object({
        workspaceId: workspaceArg,
        jobId: z.string(),
        nodeId: z
          .string()
          .optional()
          .describe("Node to read from. Defaults to a node running the job."),
        lookbackMinutes: limitArg(LOG_LIMITS.maxLookbackMinutes, 15),
        maxLines: limitArg(LOG_LIMITS.maxLines, 100),
      }),
      annotations: readOnly,
    },
    async ({ workspaceId, jobId, nodeId, lookbackMinutes, maxLines }) => {
      if (!options.scopes.includes(SCOPES.logsRead)) {
        throw new Error(
          "This connection was not granted log access. Reconnect Expanso Fleet and allow logs:read.",
        );
      }

      const workspace = await account.workspace(workspaceId);
      const client = await account.client(workspace.workspaceId);
      let targetNode = nodeId;

      if (targetNode === undefined) {
        const active = await client.jobExecutions(jobId, {
          states: ["running", "degraded"],
          limit: 5,
        });

        targetNode = active.items?.find((item) => item.node_id)?.node_id;
      }

      const token = await account.accessToken();

      const snapshot = await readLogSnapshot(
        {
          endpoint: workspace.endpoint,
          accessToken: token.accessToken,
          jobId,
          nodeId: targetNode,
          lookbackMinutes,
          maxLines,
        },
        options.openLogSocket,
      );

      return result(
        { ...snapshot },
        `${snapshot.entries.length} log lines since ${snapshot.since}${snapshot.truncated ? " (truncated)" : ""}.`,
      );
    },
  );

  const profileSchema = z.object({
    id: z.string().min(1).regex(/\S/),
    email: z.string().optional(),
    nickname: z.string().optional(),
  });

  server.registerTool(
    "get_profile",
    {
      title: "Get Expanso profile",
      description:
        "Return the Expanso account this connection is linked to. The id is stable across reconnections.",
      inputSchema: z.object({}),
      outputSchema: profileSchema,
      annotations: readOnly,
      _meta: { "openai/profile": true },
    },
    async () => {
      const settings = await account.settings();

      const profile: z.infer<typeof profileSchema> = {
        id: account.props.accountId,
        nickname: `Expanso workspace ${settings.defaultWorkspaceId}`,
      };

      if (account.props.email) profile.email = account.props.email;

      return result(profile, settings.defaultWorkspaceId);
    },
  );

  const readEntity =
    (kind: "jobs" | "nodes") =>
    async (uri: URL, variables: Record<string, string | string[]>) => {
      const workspaceId = String(variables.workspaceId);
      const id = String(variables.id);
      const client = await account.client(workspaceId);

      const text =
        kind === "jobs"
          ? jobMarkdown(
              jobView(await client.getJob(id)),
              ((await client.jobExecutions(id, { limit: 10 })).items ?? []).map(
                executionView,
              ),
            )
          : nodeMarkdown(nodeView(await client.getNode(id)));

      return {
        contents: [{ uri: uri.href, mimeType: "text/markdown", text }],
      };
    };

  server.registerResource(
    "expanso-job",
    new ResourceTemplate("expanso://workspaces/{workspaceId}/jobs/{id}", {
      list: undefined,
    }),
    { title: "Expanso job", mimeType: "text/markdown" },
    readEntity("jobs"),
  );
  server.registerResource(
    "expanso-node",
    new ResourceTemplate("expanso://workspaces/{workspaceId}/nodes/{id}", {
      list: undefined,
    }),
    { title: "Expanso node", mimeType: "text/markdown" },
    readEntity("nodes"),
  );

  server.registerResource(
    "expanso-fleet-app",
    FLEET_APP_URI,
    { title: "Expanso Fleet", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [
        {
          uri: FLEET_APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: options.appHtml,
          _meta: {
            "openai/ui": {
              preferredDisplayMode: "inline",
              availableDisplayModes: ["inline", "fullscreen"],
            },
            ui: {
              prefersBorder: true,
              csp: { connectDomains: [], resourceDomains: [] },
            },
          },
        },
      ],
    }),
  );

  return server;
}

function jobMarkdown(
  job: ReturnType<typeof jobView>,
  executions: ReturnType<typeof executionView>[],
): string {
  const lines = [
    `# Job ${job.name ?? job.id}`,
    "",
    `- ID: ${job.id}`,
    `- Type: ${job.type ?? "unknown"}`,
    `- State: ${job.state}${job.message ? ` (${job.message})` : ""}`,
    `- Version: ${job.version ?? "unknown"}`,
    `- Updated: ${job.updatedAt ?? "unknown"}`,
    "",
    "## Executions",
    ...(executions.length === 0
      ? ["No executions."]
      : executions.map(
          (execution) =>
            `- ${execution.id} on ${execution.nodeId ?? "unknown node"}: ${execution.state}${execution.message ? ` (${execution.message})` : ""}`,
        )),
  ];

  return lines.join("\n");
}

function nodeMarkdown(node: ReturnType<typeof nodeView>): string {
  return [
    `# Node ${node.name ?? node.id}`,
    "",
    `- ID: ${node.id}`,
    `- Connection: ${node.connectionState}${node.online ? " (online)" : ""}`,
    `- Last heartbeat: ${node.lastHeartbeat ?? "unknown"}`,
    `- OS/arch: ${node.os ?? "?"}/${node.arch ?? "?"}`,
    `- Agent version: ${node.agentVersion ?? "unknown"}`,
    ...(node.message ? [`- Message: ${node.message}`] : []),
  ].join("\n");
}
