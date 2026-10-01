import { z } from "zod";

// Shapes the tools return. The server builds them; the Fleet app parses them.

const labels = z.record(z.string(), z.string()).optional();

export const NodeViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  hostname: z.string().optional(),
  os: z.string().optional(),
  arch: z.string().optional(),
  agentVersion: z.string().optional(),
  connectionState: z.string(),
  online: z.boolean(),
  lastHeartbeat: z.string().optional(),
  message: z.string().optional(),
  labels,
  cpuPercent: z.number().optional(),
  memoryPercent: z.number().optional(),
  diskPercent: z.number().optional(),
});

export const JobViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  state: z.string(),
  message: z.string().optional(),
  version: z.number().optional(),
  updatedAt: z.string().optional(),
  labels,
});

export const ExecutionViewSchema = z.object({
  id: z.string(),
  jobId: z.string().optional(),
  nodeId: z.string().optional(),
  state: z.string(),
  message: z.string().optional(),
  desiredState: z.string().optional(),
  jobVersion: z.number().optional(),
  updatedAt: z.string().optional(),
  details: labels,
});

export const HistoryViewSchema = z.object({
  timestamp: z.string().optional(),
  message: z.string().optional(),
  executionId: z.string().optional(),
  details: labels,
});

const counts = z.record(z.string(), z.number());

export const FleetSummarySchema = z.object({
  workspace: z.object({
    id: z.string(),
    name: z.string().optional(),
    endpoint: z.string(),
  }),
  generatedAt: z.string(),
  nodes: z.object({
    total: z.number(),
    online: z.number(),
    byConnectionState: counts,
    offline: z.array(NodeViewSchema),
  }),
  jobs: z.object({
    /** Jobs counted, newest first; capped by the server. */
    counted: z.number(),
    more: z.boolean(),
    byState: counts,
    needsAttention: z.array(JobViewSchema),
  }),
  recentErrors: z.array(ExecutionViewSchema),
  /** A warning to show, such as an API key that expires soon. */
  notice: z.string().optional(),
});

/** Returned instead of data when the workspace cannot be read. */
export const ConnectionStateSchema = z.object({
  connection: z.object({
    status: z.enum(["not_connected", "reconnect"]),
    workspaceId: z.string().optional(),
    message: z.string(),
    /** One-time link to connect or reconnect the workspace. */
    reconnectUrl: z.string(),
  }),
});

export type ConnectionStateView = z.infer<typeof ConnectionStateSchema>;

export const JobDetailSchema = z.object({
  job: JobViewSchema,
  executions: z.array(ExecutionViewSchema),
  history: z.array(HistoryViewSchema),
});

export type NodeView = z.infer<typeof NodeViewSchema>;

export type JobView = z.infer<typeof JobViewSchema>;

export type ExecutionView = z.infer<typeof ExecutionViewSchema>;

export type HistoryView = z.infer<typeof HistoryViewSchema>;

export type FleetSummary = z.infer<typeof FleetSummarySchema>;

export type JobDetail = z.infer<typeof JobDetailSchema>;

const groupOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    state: z.string(),
    healthy: z.boolean(),
    /** Every item in this state, even when `items` is trimmed. */
    count: z.number(),
    items: z.array(item),
  });

const inventoryOf = <Item extends z.ZodType>(item: Item) =>
  z.object({
    total: z.number(),
    healthy: z.number(),
    notHealthy: z.number(),
    /** False when the counts cover only the rows loaded so far. */
    countsComplete: z.boolean(),
    /** Continues the list when the workspace has more rows than were read. */
    nextToken: z.string().optional(),
    groups: z.array(groupOf(item)),
  });

export const WorkspaceInventorySchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.string(),
  jobs: inventoryOf(JobViewSchema),
  nodes: inventoryOf(NodeViewSchema),
});

export interface InventoryGroup<View> {
  state: string;
  healthy: boolean;
  count: number;
  items: View[];
}

export interface KindInventory<View> {
  total: number;
  healthy: number;
  notHealthy: number;
  countsComplete: boolean;
  nextToken?: string;
  groups: InventoryGroup<View>[];
}

export const InventoryPageSchema = WorkspaceInventorySchema.partial({
  jobs: true,
  nodes: true,
});

export type InventoryPage = z.infer<typeof InventoryPageSchema>;

export type WorkspaceInventory = z.infer<typeof WorkspaceInventorySchema>;
