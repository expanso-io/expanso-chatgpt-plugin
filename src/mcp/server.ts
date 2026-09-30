import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { createMentions, createSettings } from "@openai/mcp-extensions/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ConnectionRequired, type Account, type Session } from "../account.js";
import { SCOPES } from "../config.js";
import type { Connection } from "../connections.js";
import { ADD_LINK_TTL_SECONDS } from "../links.js";
import {
  readLogSnapshot,
  LOG_LIMITS,
  type OpenLogSocket,
} from "../cloud/logs.js";
import type { ExecutionState } from "../cloud/types.js";
import { registerControlTools } from "./control.js";
import {
  describeDashboard,
  jobDashboard,
  nodeDetail,
  workspaceDashboard,
} from "./dashboard.js";
import { describeFleet, fleetSummary, listFiltered } from "./fleet.js";
import { describeFleets, fleetsView } from "./fleets.js";
import type { WorkspaceInventory } from "./contracts.js";
import {
  describeCounts,
  describeInventory,
  inventoryPage,
  trimGroups,
  workspaceInventory,
} from "./inventory.js";
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

/** Changes only this plugin's own connection records, never Expanso. */
const pluginState = {
  readOnlyHint: false,
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
  /** The account's cached workspaces when the request arrived. */
  connections: readonly Connection[];
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

function scanNote(scanned: number | undefined, noun: string): string {
  return scanned === undefined
    ? ""
    : ` among the ${scanned} most recent ${noun} checked; older ${noun} were not searched`;
}

function workspaceLabel(workspace: Session["workspace"]): string {
  return workspace.name ?? workspace.workspaceId;
}

interface Answer {
  data: StructuredContent;
  text: string;
  /** True when the text already names the workspace. */
  named?: boolean;
}

/** Explains why nothing can be read, with the single link that fixes it. */
function connectionText({ state }: ConnectionRequired): string {
  const action =
    state.status === "reconnect" ? "Reconnect it here" : "Connect one here";

  return `${state.message}\n\n${action}: ${state.reconnectUrl}\nThe link works once, for ${ADD_LINK_TTL_SECONDS / 60} minutes.`;
}

function connectionResult(error: ConnectionRequired) {
  return result({ connection: { ...error.state } }, connectionText(error));
}

/**
 * Builds the MCP server for one request. Tools registered here read Expanso,
 * and the workspace tools change which cached workspace is active. The tools
 * that change Expanso are in control.ts; each runs only with a signed preview
 * the user confirmed.
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
    title: "Expanso",
    version: SERVER_VERSION,
    icons: [icon],
  });

  /** Reads the active workspace, or explains how to connect one. */
  const read = async (work: (session: Session) => Promise<Answer>) => {
    let session: Session;

    try {
      session = await account.session();
    } catch (error) {
      if (error instanceof ConnectionRequired) return connectionResult(error);

      throw error;
    }

    const answer = await work(session);

    const text = answer.named
      ? answer.text
      : `Workspace ${workspaceLabel(session.workspace)}: ${answer.text}`;

    return result(
      answer.data,
      session.notice === undefined ? text : `${text}\n\n${session.notice}`,
    );
  };

  const [firstWorkspace, ...otherWorkspaces] = options.connections.map(
    (connection) => connection.workspaceId,
  );

  // A settings enum needs at least one value; with nothing cached there is
  // nothing to choose, and add_workspace is the way forward.
  if (firstWorkspace !== undefined) {
    const activeId = async () =>
      (await account.activeConnection())?.workspaceId ?? firstWorkspace;

    createSettings(server).register({
      fields: {
        activeWorkspaceId: {
          schema: z.enum([firstWorkspace, ...otherWorkspaces]),
          title: "Active workspace",
          description:
            "The one Expanso workspace Expanso Fleet reads. Changing it switches workspaces; the others stay connected.",
        },
      },
      read: async () => ({ activeWorkspaceId: await activeId() }),
      update: async (set) => {
        if (set.activeWorkspaceId !== undefined) {
          await account.switchWorkspace(set.activeWorkspaceId);
        }

        return { activeWorkspaceId: await activeId() };
      },
    });
  }

  createMentions(server).setHandler(async ({ query }) => {
    const active = await account.activeConnection();

    if (!active || active.needsReconnect) return { items: [] };

    try {
      const { client, workspace } = await account.session();

      return {
        items: await searchMentions(client, workspace.workspaceId, query),
      };
    } catch (error) {
      if (error instanceof ConnectionRequired) return { items: [] };

      throw error;
    }
  });

  const openFleet = () =>
    read(async (session) => {
      const summary = await fleetSummary(session.client, session.workspace);

      if (session.notice !== undefined) summary.notice = session.notice;

      return {
        data: { ...summary },
        text: describeFleet(summary),
        named: true,
      };
    });

  server.registerTool(
    "fleet.open",
    {
      title: "Expanso Fleet",
      description:
        "Open the Expanso Fleet view: node connectivity, job health, and recent failed or degraded executions for the active workspace.",
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
    "list_workspaces",
    {
      title: "List workspaces",
      description:
        "List the Expanso workspaces connected to Expanso Fleet, which one is active (every other tool reads only the active one), and when each key expires or needs reconnecting.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    async () => {
      const workspaces = await account.connections();

      if (workspaces.length === 0) {
        return result(
          { workspaces: [] },
          "No workspace is connected. Use add_workspace to connect one.",
        );
      }

      const lines = workspaces.map((item) => {
        const notes = [
          item.active ? "active" : "connected",
          item.needsReconnect ? "needs reconnecting" : undefined,
          item.keyExpiresAt ? `key expires ${item.keyExpiresAt}` : undefined,
        ].filter((note) => note !== undefined);

        return `- ${item.name ?? item.workspaceId} (${notes.join(", ")})`;
      });

      return result(
        { workspaces: workspaces.map((item) => ({ ...item })) },
        `${workspaces.length} connected workspaces:\n${lines.join("\n")}`,
      );
    },
  );

  server.registerTool(
    "switch_workspace",
    {
      title: "Switch workspace",
      description:
        "Make another connected Expanso workspace the active one. Its cached key is reused; no key is created or revoked, and the other workspaces stay connected.",
      inputSchema: z.object({
        workspaceId: z.string().describe("A workspace from list_workspaces."),
      }),
      annotations: pluginState,
    },
    async ({ workspaceId }) => {
      const active = await account.switchWorkspace(workspaceId);

      const reconnect = active.needsReconnect
        ? " Its key no longer works, so it needs reconnecting before it can be read; add_workspace gives the link."
        : "";

      return result(
        { workspace: { ...active } },
        `Switched to workspace ${active.name ?? active.workspaceId}. The other workspaces stay connected; nothing was revoked.${reconnect}`,
      );
    },
  );

  server.registerTool(
    "add_workspace",
    {
      title: "Connect a workspace",
      description:
        "Get a one-time link where the person pastes an Expanso API key and a workspace endpoint to connect that workspace, or to reconnect one whose key stopped working. The connected workspace becomes active.",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .optional()
          .describe(
            "A connected workspace to reconnect; fills in its endpoint.",
          ),
      }),
      annotations: { ...pluginState, idempotentHint: false },
    },
    async ({ workspaceId }) => {
      const link = await account.addLink(workspaceId);

      return result(
        { url: link.url, expiresAt: link.expiresAt },
        `Open this link to connect a workspace: ${link.url}\nPaste an Expanso API key and the workspace endpoint there. The link works once, for ${ADD_LINK_TTL_SECONDS / 60} minutes.`,
      );
    },
  );

  server.registerTool(
    "disconnect_workspace",
    {
      title: "Disconnect workspace",
      description:
        "Forget a connected Expanso workspace: its cached API key is deleted from Expanso Fleet. The key itself stays valid in Expanso Cloud until it is revoked there.",
      inputSchema: z.object({
        workspaceId: z.string().describe("A workspace from list_workspaces."),
      }),
      annotations: { ...pluginState, destructiveHint: true },
    },
    async ({ workspaceId }) => {
      const outcome = await account.disconnect(workspaceId);

      const revoke = outcome.revoked
        ? "Expanso Cloud revoked its key."
        : `Expanso Cloud cannot revoke this key for Expanso Fleet yet, so revoke it yourself on the workspace's Keys page: ${outcome.keysPageUrl}`;

      const next = outcome.active
        ? `The active workspace is now ${outcome.active.name ?? outcome.active.workspaceId}.`
        : "No workspace is connected now; use add_workspace to connect one.";

      return result(
        {
          removed: { ...outcome.removed },
          revoked: outcome.revoked,
          keysPageUrl: outcome.keysPageUrl,
        },
        `Disconnected workspace ${workspaceId}: its cached key is deleted from Expanso Fleet. ${revoke}\n${next}`,
      );
    },
  );

  server.registerTool(
    "fleet_overview",
    {
      title: "Fleet overview",
      description:
        "Answer questions like 'what jobs do I have?', 'which nodes are healthy and which are not?', or 'what is failing?'. Returns counts first (healthy vs not healthy) for every job and node in the active workspace, then the items grouped by state, problems first. Nodes are healthy when connected; jobs are healthy when running or completed. Use get_job or recent_errors to explain a specific failure.",
      inputSchema: z.object({
        include: z
          .enum(["both", "jobs", "nodes"])
          .optional()
          .describe("Which inventory to return. Default both."),
        perGroup: limitArg(200, 25).describe(
          "Items listed per state group; counts always cover everything. Default 25, max 200.",
        ),
      }),
      annotations: readOnly,
    },
    ({ include, perGroup }) =>
      read(async ({ client, workspace }) => {
        const inventory = await workspaceInventory(
          client,
          workspace.workspaceId,
        );

        const scope = include ?? "both";
        const limit = perGroup ?? 25;

        const trimmed = {
          ...inventory,
          jobs: {
            ...inventory.jobs,
            groups: trimGroups(inventory.jobs.groups, limit),
          },
          nodes: {
            ...inventory.nodes,
            groups: trimGroups(inventory.nodes.groups, limit),
          },
        };

        const structured: Partial<WorkspaceInventory> = {
          workspaceId: trimmed.workspaceId,
          generatedAt: trimmed.generatedAt,
        };

        if (scope !== "nodes") structured.jobs = trimmed.jobs;

        if (scope !== "jobs") structured.nodes = trimmed.nodes;

        return {
          data: structured,
          text: describeInventory(trimmed, scope),
        };
      }),
  );

  server.registerTool(
    "fleet.inventory",
    {
      title: "Load every job and node",
      inputSchema: z.object({
        workspaceId: z
          .string()
          .optional()
          .describe(
            "The workspace the caller expects; the call fails if another is active.",
          ),
        kind: z
          .enum(["jobs", "nodes"])
          .optional()
          .describe("The list to continue. Required with nextToken."),
        nextToken: z
          .string()
          .optional()
          .describe("The nextToken of that list from an earlier result."),
      }),
      annotations: readOnly,
      _meta: { ui: { visibility: ["app"] } },
    },
    ({ workspaceId, kind, nextToken }) => {
      if (nextToken !== undefined && kind === undefined) {
        throw new Error("Say which list to continue: kind is jobs or nodes.");
      }

      return read(async ({ client, workspace }) => {
        if (
          workspaceId !== undefined &&
          workspaceId !== workspace.workspaceId
        ) {
          throw new Error(
            `The active workspace is now ${workspace.workspaceId}. Refresh the Fleet view.`,
          );
        }

        const inventory =
          nextToken !== undefined && kind !== undefined
            ? await inventoryPage(
                client,
                workspace.workspaceId,
                kind,
                nextToken,
              )
            : await workspaceInventory(client, workspace.workspaceId);

        return { data: { ...inventory }, text: describeCounts(inventory) };
      });
    },
  );

  server.registerTool(
    "list_nodes",
    {
      title: "List nodes",
      description:
        "List edge nodes in the active Expanso workspace with connectivity (online means connected), labels, and resource usage.",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Node ID or name prefix."),
        onlyOffline: z
          .boolean()
          .optional()
          .describe("Only nodes that are not connected."),
        limit: limitArg(100, 50),
      }),
      annotations: readOnly,
    },
    ({ prefix, onlyOffline, limit }) =>
      read(async ({ client }) => {
        const list = await listFiltered(
          (page) => client.listNodes({ prefix, ...page }),
          nodeView,
          onlyOffline ? (node) => !node.online : undefined,
          limit ?? 50,
        );

        const nodes = list.items;

        return {
          data: { nodes, more: list.more },
          text: `${nodes.length} nodes (${nodes.filter((node) => node.online).length} online)${scanNote(list.partialScan, "nodes")}.`,
        };
      }),
  );

  server.registerTool(
    "get_node",
    {
      title: "Get node",
      description: "Get one edge node and the executions placed on it.",
      inputSchema: z.object({ nodeId: z.string() }),
      annotations: readOnly,
    },
    ({ nodeId }) =>
      read(async ({ client }) => {
        const [node, executions] = await Promise.all([
          client.getNode(nodeId),
          client.listExecutions({ nodeIds: [nodeId], limit: 20 }),
        ]);

        const view = nodeView(node);

        return {
          data: {
            node: view,
            executions: (executions.items ?? []).map(executionView),
          },
          text: `Node ${view.name ?? view.id} is ${view.connectionState}.`,
        };
      }),
  );

  server.registerTool(
    "list_jobs",
    {
      title: "List jobs",
      description:
        "List jobs (pipelines and other workloads) in the active Expanso workspace, newest updates first, with state such as running, degraded, or failed.",
      inputSchema: z.object({
        prefix: z.string().optional().describe("Job ID or name prefix."),
        state: z
          .string()
          .optional()
          .describe("Only jobs in this state, for example degraded or failed."),
        limit: limitArg(200, 50),
      }),
      annotations: readOnly,
    },
    ({ prefix, state, limit }) =>
      read(async ({ client }) => {
        // "degraded" is not a server-side filter, so state is applied here.
        const list = await listFiltered(
          (page) => client.listJobs({ prefix, ...page }),
          jobView,
          state ? (job) => job.state === state : undefined,
          limit ?? 50,
        );

        return {
          data: { jobs: list.items, more: list.more },
          text: `${list.items.length} jobs${scanNote(list.partialScan, "jobs")}.`,
        };
      }),
  );

  server.registerTool(
    "get_job",
    {
      title: "Get job",
      description:
        "Get one job with its current executions and recent history. Use this first to explain why a job is degraded or failing.",
      inputSchema: z.object({ jobId: z.string() }),
      annotations: readOnly,
    },
    ({ jobId }) =>
      read(async ({ client }) => {
        const [job, executions, history] = await Promise.all([
          client.getJob(jobId),
          client.jobExecutions(jobId, { limit: 20 }),
          client.jobHistory(jobId, { limit: 20 }),
        ]);

        const view = jobView(job);

        return {
          data: {
            job: view,
            executions: (executions.items ?? []).map(executionView),
            history: (history.items ?? []).map(historyView),
          },
          text: `Job ${view.name ?? view.id} is ${view.state}${view.message ? `: ${view.message}` : ""}.`,
        };
      }),
  );

  server.registerTool(
    "list_executions",
    {
      title: "List executions",
      description:
        "List job executions in the active workspace, optionally for one job or node and filtered by state.",
      inputSchema: z.object({
        jobId: z.string().optional(),
        nodeId: z.string().optional(),
        states: z.array(z.enum(EXECUTION_STATES)).optional(),
        limit: limitArg(100, 25),
      }),
      annotations: readOnly,
    },
    ({ jobId, nodeId, states, limit }) =>
      read(async ({ client }) => {
        const page = await client.listExecutions({
          jobId,
          nodeIds: nodeId ? [nodeId] : undefined,
          states,
          limit: limit ?? 25,
        });

        const executions = (page.items ?? []).map(executionView);

        return {
          data: { executions, more: Boolean(page.next_token) },
          text: `${executions.length} executions.`,
        };
      }),
  );

  server.registerTool(
    "get_execution",
    {
      title: "Get execution",
      description:
        "Get one execution with its state transition history and failure messages.",
      inputSchema: z.object({ executionId: z.string() }),
      annotations: readOnly,
    },
    ({ executionId }) =>
      read(async ({ client }) => {
        const [execution, history] = await Promise.all([
          client.getExecution(executionId),
          client.executionHistory(executionId, { limit: 50 }),
        ]);

        const view = executionView(execution);

        return {
          data: {
            execution: view,
            history: (history.items ?? []).map(historyView),
          },
          text: `Execution ${view.id} is ${view.state}${view.message ? `: ${view.message}` : ""}.`,
        };
      }),
  );

  server.registerTool(
    "recent_errors",
    {
      title: "Recent errors",
      description:
        "List the most recently updated failed, degraded, or lost executions in the active workspace, with state history for the newest few.",
      inputSchema: z.object({ limit: limitArg(20, 10) }),
      annotations: readOnly,
    },
    ({ limit }) =>
      read(async ({ client }) => {
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

        return {
          data: { executions, histories: withHistory },
          text:
            executions.length === 0
              ? "No failed, degraded, or lost executions."
              : `${executions.length} recent failed, degraded, or lost executions.`,
        };
      }),
  );

  server.registerTool(
    "get_job_logs",
    {
      title: "Get job logs",
      description: `Read a bounded snapshot of recent log lines for a job in the active workspace from one node: at most ${LOG_LIMITS.maxLines} lines, ${LOG_LIMITS.maxSeconds} seconds of collection, and ${LOG_LIMITS.maxLookbackMinutes} minutes of lookback.`,
      inputSchema: z.object({
        jobId: z.string(),
        nodeId: z
          .string()
          .optional()
          .describe(
            "Node to read from. Defaults to the node of the job's most recently updated execution.",
          ),
        lookbackMinutes: limitArg(LOG_LIMITS.maxLookbackMinutes, 15),
        maxLines: limitArg(LOG_LIMITS.maxLines, 100),
      }),
      annotations: readOnly,
    },
    ({ jobId, nodeId, lookbackMinutes, maxLines }) => {
      if (!options.scopes.includes(SCOPES.logs)) {
        throw new Error(
          "This connection was not granted log access. Reconnect Expanso Fleet and allow logs.",
        );
      }

      return read(async ({ client, workspace, accessToken }) => {
        let targetNode = nodeId;

        if (targetNode === undefined) {
          const recent = await client.jobExecutions(jobId, { limit: 5 });

          targetNode = recent.items?.find((item) => item.node_id)?.node_id;
        }

        const snapshot = await readLogSnapshot(
          {
            endpoint: workspace.endpoint,
            accessToken,
            jobId,
            nodeId: targetNode,
            lookbackMinutes,
            maxLines,
          },
          options.openLogSocket,
        );

        return {
          data: { ...snapshot },
          text: `${snapshot.entries.length} log lines since ${snapshot.since}${snapshot.truncated ? " (truncated)" : ""}.`,
        };
      });
    },
  );

  const dashboard = () =>
    read(async ({ client, workspace }) => {
      const view = await workspaceDashboard(client, workspace.workspaceId);

      return { data: { ...view }, text: describeDashboard(view) };
    });

  server.registerTool(
    "fleet_dashboard",
    {
      title: "Fleet dashboard",
      description:
        "Health over time for the active workspace: nodes online and CPU for the last 30 minutes, executions placed and finished per hour and failures per hour for the last day, the jobs failing most, and per-node load. Use for 'how is the fleet doing?' or 'what changed today?'.",
      inputSchema: z.object({}),
      annotations: readOnly,
    },
    dashboard,
  );

  server.registerTool(
    "fleet.dashboard",
    {
      title: "Load the Fleet dashboard",
      inputSchema: z.object({}),
      annotations: readOnly,
      _meta: { ui: { visibility: ["app"] } },
    },
    dashboard,
  );

  server.registerTool(
    "node_dashboard",
    {
      title: "Node dashboard",
      description:
        "One node in the active workspace in detail: connection, CPU, memory, and disk for the last 30 minutes, and the executions placed on it by state.",
      inputSchema: z.object({ nodeId: z.string() }),
      annotations: readOnly,
    },
    ({ nodeId }) =>
      read(async ({ client }) => {
        const view = await nodeDetail(client, nodeId);
        const last = view.resources.points.at(-1);

        return {
          data: { ...view },
          text: `Node ${view.node.name ?? view.node.id} is ${view.node.connectionState}${last?.cpuPercent !== undefined ? `, CPU ${last.cpuPercent}%` : ""}. Executions: ${
            Object.entries(view.executionsByState)
              .map(([state, count]) => `${count} ${state}`)
              .join(", ") || "none"
          }.`,
        };
      }),
  );

  server.registerTool(
    "job_dashboard",
    {
      title: "Job dashboard",
      description:
        "One job in the active workspace in detail: its state on every node, failures per hour for the last day, recent history, and its versions (for rollback).",
      inputSchema: z.object({ jobId: z.string() }),
      annotations: readOnly,
    },
    ({ jobId }) =>
      read(async ({ client }) => {
        const view = await jobDashboard(client, jobId);

        const failures = view.failures.reduce(
          (sum, bucket) =>
            sum + Object.values(bucket.counts).reduce((a, b) => a + b, 0),
          0,
        );

        return {
          data: { ...view },
          text: `Job ${view.job.name ?? view.job.id} is ${view.job.state} on ${view.nodes.length} nodes (${
            Object.entries(view.executionsByState)
              .map(([state, count]) => `${count} ${state}`)
              .join(", ") || "none"
          }); ${failures} failed, degraded, or lost executions in the last day; ${view.versions.length} versions.`,
        };
      }),
  );

  server.registerTool(
    "fleets.list",
    {
      title: "Load fleets",
      inputSchema: z.object({}),
      annotations: readOnly,
      _meta: { ui: { visibility: ["app"] } },
    },
    async () => {
      const view = await fleetsView({
        directory: account.directory(),
        connections: await account.connections(),
        activeClient: async () => (await account.session()).client,
      });

      return result({ ...view }, describeFleets(view));
    },
  );

  registerControlTools(server, account, connectionResult);

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
      const active = await account.activeConnection();
      const label = active ? (active.name ?? active.workspaceId) : undefined;

      const profile: z.infer<typeof profileSchema> = {
        id: account.props.accountId,
        nickname: label ? `Expanso workspace ${label}` : "Expanso",
      };

      if (account.props.email) profile.email = account.props.email;

      return result(profile, label ?? "No workspace connected");
    },
  );

  const readEntity =
    (kind: "jobs" | "nodes") =>
    async (uri: URL, variables: Record<string, string | string[]>) => {
      const workspaceId = String(variables.workspaceId);
      const id = String(variables.id);
      const { client, workspace } = await account
        .session()
        .catch((error: unknown) => {
          if (error instanceof ConnectionRequired) {
            throw new Error(connectionText(error));
          }

          throw error;
        });

      if (workspaceId !== workspace.workspaceId) {
        throw new Error(
          `This item is in workspace ${workspaceId}, but the active workspace is ${workspace.workspaceId}. Switch workspaces to read it.`,
        );
      }

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
