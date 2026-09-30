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
});

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

// Fleets: every workspace this person can reach.

export const FleetStatusViewSchema = z.object({
  nodesTotal: z.number().optional(),
  nodesHealthy: z.number().optional(),
  nodesUnhealthy: z.number().optional(),
  /** Unset when there were more jobs than were counted. */
  jobsTotal: z.number().optional(),
  jobsRunning: z.number().optional(),
  jobsFailing: z.number().optional(),
  /** Set when job counts cover only this many of the newest jobs. */
  jobsCountedFrom: z.number().optional(),
  lastActivityAt: z.string().optional(),
});

export const FleetViewSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  organizationName: z.string().optional(),
  endpoint: z.string().optional(),
  /** Expanso Cloud's lifecycle state, for example ready or provisioning. */
  cloudState: z.string().optional(),
  /** This connection holds a key for it, so it can be read and changed. */
  linked: z.boolean(),
  /** The default workspace for the Fleet view and tools. */
  active: z.boolean(),
  /** When the linked key stops working; unset when Expanso did not say. */
  keyExpiresAt: z.string().optional(),
  status: FleetStatusViewSchema.optional(),
  statusSource: z.enum(["cloud", "workspace", "unavailable"]),
  statusError: z.string().optional(),
});

export const FleetsViewSchema = z.object({
  generatedAt: z.string(),
  /** False until Expanso Cloud lists every workspace; then only linked ones show. */
  directoryAvailable: z.boolean(),
  activeWorkspaceId: z.string(),
  fleets: z.array(FleetViewSchema),
});

export type FleetStatusView = z.infer<typeof FleetStatusViewSchema>;

export type FleetView = z.infer<typeof FleetViewSchema>;

export type FleetsView = z.infer<typeof FleetsViewSchema>;

// Dashboards, built only from what the orchestrator API exposes.

const minMaxView = z.object({
  avg: z.number().optional(),
  max: z.number().optional(),
  min: z.number().optional(),
});

export const TimeBucketSchema = z.object({
  /** Bucket start, ISO 8601. */
  t: z.string(),
  counts: z.record(z.string(), z.number()),
});

export const HealthPointSchema = z.object({
  t: z.string(),
  /** Nodes that sent a heartbeat sample in this step. */
  nodesReporting: z.number(),
  cpuAvgPercent: z.number().optional(),
  cpuMaxPercent: z.number().optional(),
});

export const DashboardNodeSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  connectionState: z.string(),
  online: z.boolean(),
  cpuPercent: z.number().optional(),
  memoryPercent: z.number().optional(),
  diskPercent: z.number().optional(),
  /** CPU percent per step over the health window; null where no sample. */
  cpuSeries: z.array(z.number().nullable()),
  executions: z.record(z.string(), z.number()),
});

export const DashboardSchema = z.object({
  workspaceId: z.string(),
  generatedAt: z.string(),
  orchestrator: z.object({
    version: z.string().optional(),
    status: z.string().optional(),
    uptimeSeconds: z.number().optional(),
  }),
  nodes: z.object({
    total: z.number(),
    online: z.number(),
    byConnectionState: counts,
    resources: z
      .object({ cpu: minMaxView, memory: minMaxView, disk: minMaxView })
      .optional(),
  }),
  jobs: z.object({ total: z.number(), byState: counts }),
  executions: z.object({ total: z.number(), byState: counts }),
  queue: z
    .object({
      ready: z.number().optional(),
      inflight: z.number().optional(),
      pending: z.number().optional(),
      waiting: z.number().optional(),
    })
    .optional(),
  health: z.object({
    windowMinutes: z.number(),
    stepSeconds: z.number(),
    points: z.array(HealthPointSchema),
  }),
  /** Executions placed and finished per hour, from execution timestamps. */
  activity: z.object({
    windowHours: z.number(),
    sampled: z.number(),
    buckets: z.array(TimeBucketSchema),
  }),
  failures: z.object({
    windowHours: z.number(),
    total: z.number(),
    buckets: z.array(TimeBucketSchema),
    topJobs: z.array(
      z.object({
        jobId: z.string(),
        name: z.string().optional(),
        count: z.number(),
      }),
    ),
  }),
  topNodes: z.array(DashboardNodeSchema),
  /** What the API does not expose, said plainly instead of guessed. */
  notes: z.array(z.string()),
});

export const NodeDetailSchema = z.object({
  node: NodeViewSchema,
  resources: z.object({
    windowMinutes: z.number(),
    points: z.array(
      z.object({
        t: z.string(),
        cpuPercent: z.number().optional(),
        memoryBytes: z.number().optional(),
        diskBytes: z.number().optional(),
      }),
    ),
  }),
  executionsByState: counts,
  executions: z.array(ExecutionViewSchema),
});

export const JobDashboardSchema = z.object({
  job: JobViewSchema,
  executionsByState: counts,
  nodes: z.array(
    z.object({
      nodeId: z.string(),
      state: z.string(),
      message: z.string().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
  failures: z.array(TimeBucketSchema),
  history: z.array(HistoryViewSchema),
  versions: z.array(
    z.object({
      version: z.number(),
      state: z.string().optional(),
      updatedAt: z.string().optional(),
    }),
  ),
});

export type Dashboard = z.infer<typeof DashboardSchema>;

export type DashboardNode = z.infer<typeof DashboardNodeSchema>;

export type NodeDetail = z.infer<typeof NodeDetailSchema>;

export type JobDashboard = z.infer<typeof JobDashboardSchema>;

export type TimeBucket = z.infer<typeof TimeBucketSchema>;

// Change previews. A plan tool returns one; its `next` call is what the
// person confirms.

export const ChangePreviewSchema = z.object({
  action: z.string(),
  /** One line naming the change, its target, and its size. */
  summary: z.string(),
  destructive: z.boolean(),
  workspaceId: z.string(),
  targetName: z.string(),
  targetNodes: z.object({
    count: z.number(),
    names: z.array(z.string()),
    more: z.boolean(),
    selector: z.string().optional(),
  }),
  diff: z
    .object({
      text: z.string(),
      added: z.number(),
      removed: z.number(),
      truncated: z.boolean(),
    })
    .optional(),
  warnings: z.array(z.string()),
  next: z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.json()),
  }),
});

export const ChangeResultSchema = z.object({
  action: z.string(),
  ok: z.literal(true),
  summary: z.string(),
  jobId: z.string().optional(),
  nodeId: z.string().optional(),
  version: z.number().optional(),
  warnings: z.array(z.string()),
});

export type ChangePreview = z.infer<typeof ChangePreviewSchema>;

export type ChangeResult = z.infer<typeof ChangeResultSchema>;
