import type { WorkspaceClient } from "../cloud/client.js";
import type { Execution, NodeMetric, QueryRange } from "../cloud/types.js";
import type {
  Dashboard,
  DashboardNode,
  JobDashboard,
  NodeDetail,
  TimeBucket,
} from "./contracts.js";
import { collectAll } from "./inventory.js";
import {
  countBy,
  ERROR_EXECUTION_STATES,
  executionView,
  historyView,
  jobView,
  nodeView,
} from "./views.js";

// Dashboards use only what the orchestrator API serves to an API key:
// /status and /nodes/-/stats for totals, /metrics/query_range for node
// heartbeat samples (kept in memory for about 30 minutes), and execution and
// job timestamps for activity and failures over the last day. Per-pipeline
// throughput in messages or bytes lives in Expanso Cloud's metrics service,
// which API keys cannot read, so it is named as missing rather than guessed.

/** Node heartbeat history the orchestrator keeps. */
export const HEALTH_WINDOW_MINUTES = 30;

const HEALTH_STEP_SECONDS = 60;

export const ACTIVITY_WINDOW_HOURS = 24;

/** Executions read for activity and failures. */
const EXECUTION_SAMPLE = 1000;

const TOP_NODES = 50;

const FINISHED_STATES = new Set(["completed", "failed", "stopped", "lost"]);

const ERROR_STATES = new Set<string>(ERROR_EXECUTION_STATES);

type DashboardClient = Pick<
  WorkspaceClient,
  | "status"
  | "nodeStats"
  | "listNodes"
  | "listJobs"
  | "listExecutions"
  | "queryRange"
  | "getNode"
  | "getJob"
  | "jobExecutions"
  | "jobHistory"
  | "jobVersions"
>;

export const DASHBOARD_NOTES = {
  throughput:
    "Pipeline throughput (messages and bytes per second) is not available to API keys; Expanso Cloud shows it on each pipeline's page. Activity here counts executions placed and finished.",
  health: `Node CPU history covers the last ${HEALTH_WINDOW_MINUTES} minutes, which is what the orchestrator keeps.`,
};

export async function workspaceDashboard(
  client: DashboardClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<Dashboard> {
  const end = now.getTime() / 1000;
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_HOURS * 3_600_000);

  const [status, stats, nodes, jobs, recent, failures, cpu] = await Promise.all(
    [
      optional(client.status()),
      client.nodeStats(),
      collectAll((page) => client.listNodes(page), nodeView),
      client.listJobs({ limit: 1000 }),
      client.listExecutions({ limit: EXECUTION_SAMPLE }),
      client.listExecutions({
        states: [...ERROR_EXECUTION_STATES],
        limit: EXECUTION_SAMPLE,
      }),
      optional(
        client.queryRange("process_cpu_utilization_ratio", {
          start: end - HEALTH_WINDOW_MINUTES * 60,
          end,
          step: HEALTH_STEP_SECONDS,
        }),
      ),
    ],
  );

  const notes = [DASHBOARD_NOTES.throughput, DASHBOARD_NOTES.health];
  const jobViews = (jobs.items ?? []).map(jobView);
  const jobNames = new Map(jobViews.map((job) => [job.id, job.name]));
  const recentItems = recent.items ?? [];

  const failureItems = (failures.items ?? []).filter((item) =>
    after(item.status?.updated_at, since),
  );

  if (!cpu) notes.push("Node CPU history is unavailable from this workspace.");

  const byConnectionState =
    status?.nodes?.by_connection ??
    stats.nodes_by_connection_state ??
    countBy(nodes.items, (node) => node.connectionState);

  const series = cpuSeries(cpu, end, HEALTH_STEP_SECONDS);

  const execsByNode = new Map<string, Execution[]>();

  for (const execution of recentItems) {
    if (!execution.node_id) continue;

    const list = execsByNode.get(execution.node_id) ?? [];

    list.push(execution);
    execsByNode.set(execution.node_id, list);
  }

  const topNodes: DashboardNode[] = nodes.items
    .filter((node) => node.connectionState !== "deleted")
    .sort(
      (a, b) =>
        Number(a.online) - Number(b.online) ||
        (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1),
    )
    .slice(0, TOP_NODES)
    .map((node) => ({
      id: node.id,
      name: node.name,
      connectionState: node.connectionState,
      online: node.online,
      cpuPercent: node.cpuPercent,
      memoryPercent: node.memoryPercent,
      diskPercent: node.diskPercent,
      cpuSeries: series.byNode.get(node.id) ?? [],
      executions: countBy(execsByNode.get(node.id) ?? [], stateOf),
    }));

  const failingJobs = countBy(
    failureItems.filter((item) => item.job_id),
    (item) => item.job_id!,
  );

  const resources = stats.resource_stats;

  return {
    workspaceId,
    generatedAt: now.toISOString(),
    orchestrator: {
      version: status?.runtime?.version,
      status: status?.runtime?.status,
      uptimeSeconds: status?.runtime?.uptime_seconds,
    },
    nodes: {
      total: status?.nodes?.total ?? stats.total_nodes ?? nodes.items.length,
      online: byConnectionState.connected ?? 0,
      byConnectionState,
      resources: resources && {
        cpu: minMax(resources.cpu),
        memory: minMax(resources.memory),
        disk: minMax(resources.disk),
      },
    },
    jobs: {
      total: status?.jobs?.total ?? jobViews.length,
      byState: status?.jobs?.by_state ?? countBy(jobViews, (job) => job.state),
    },
    executions: {
      total: status?.executions?.total ?? recentItems.length,
      byState: status?.executions?.by_state ?? countBy(recentItems, stateOf),
    },
    queue: status?.evaluations,
    health: {
      windowMinutes: HEALTH_WINDOW_MINUTES,
      stepSeconds: HEALTH_STEP_SECONDS,
      points: series.points,
    },
    activity: {
      windowHours: ACTIVITY_WINDOW_HOURS,
      sampled: recentItems.length,
      buckets: activityBuckets(recentItems, since, now),
    },
    failures: {
      windowHours: ACTIVITY_WINDOW_HOURS,
      total: failureItems.length,
      buckets: hourly(
        failureItems,
        since,
        now,
        (item) => item.status?.updated_at,
        stateOf,
      ),
      topJobs: Object.entries(failingJobs)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 10)
        .map(([jobId, count]) => ({
          jobId,
          name: jobNames.get(jobId),
          count,
        })),
    },
    topNodes,
    notes,
  };
}

export async function nodeDetail(
  client: DashboardClient,
  nodeId: string,
  now: Date = new Date(),
): Promise<NodeDetail> {
  const end = now.getTime() / 1000;

  const range = {
    start: end - HEALTH_WINDOW_MINUTES * 60,
    end,
    step: HEALTH_STEP_SECONDS,
  };

  const metric = (name: NodeMetric) => optional(client.queryRange(name, range));

  const [node, executions, cpu, memory, disk] = await Promise.all([
    client.getNode(nodeId),
    client.listExecutions({ nodeIds: [nodeId], limit: 100 }),
    metric("process_cpu_utilization_ratio"),
    metric("process_memory_usage_bytes"),
    metric("process_disk_usage_bytes"),
  ]);

  const points = new Map<number, NodeDetail["resources"]["points"][number]>();

  const add = (
    range: QueryRange | undefined,
    key: "cpuPercent" | "memoryBytes" | "diskBytes",
    scale = 1,
  ) => {
    const values =
      range?.data?.result?.find(
        (item) =>
          item.metric?.instance === nodeId ||
          item.metric?.service_instance === nodeId,
      )?.values ?? [];

    for (const [t, raw] of values) {
      const value = Number(raw);

      if (!Number.isFinite(value)) continue;

      const point = points.get(t) ?? { t: new Date(t * 1000).toISOString() };

      point[key] = round(value * scale);
      points.set(t, point);
    }
  };

  add(cpu, "cpuPercent", 100);
  add(memory, "memoryBytes");
  add(disk, "diskBytes");

  const items = executions.items ?? [];

  return {
    node: nodeView(node),
    resources: {
      windowMinutes: HEALTH_WINDOW_MINUTES,
      points: [...points.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, point]) => point),
    },
    executionsByState: countBy(items, stateOf),
    executions: items.slice(0, 25).map(executionView),
  };
}

export async function jobDashboard(
  client: DashboardClient,
  jobId: string,
  now: Date = new Date(),
): Promise<JobDashboard> {
  const since = new Date(now.getTime() - ACTIVITY_WINDOW_HOURS * 3_600_000);

  const [job, executions, history, versions] = await Promise.all([
    client.getJob(jobId),
    client.jobExecutions(jobId, { limit: EXECUTION_SAMPLE }),
    client.jobHistory(jobId, { limit: 50 }),
    optional(client.jobVersions(jobId)),
  ]);

  const items = executions.items ?? [];

  // The newest execution per node is that node's current state for the job.
  const latest = new Map<string, Execution>();

  for (const execution of items) {
    if (execution.node_id && !latest.has(execution.node_id)) {
      latest.set(execution.node_id, execution);
    }
  }

  const failed = items.filter(
    (item) =>
      ERROR_STATES.has(stateOf(item)) && after(item.status?.updated_at, since),
  );

  return {
    job: jobView(job),
    executionsByState: countBy([...latest.values()], stateOf),
    nodes: [...latest.values()].map((execution) => {
      const view = executionView(execution);

      return {
        nodeId: view.nodeId ?? "",
        state: view.state,
        message: view.message,
        updatedAt: view.updatedAt,
      };
    }),
    failures: hourly(
      failed,
      since,
      now,
      (item) => item.status?.updated_at,
      stateOf,
    ),
    history: (history.items ?? []).map(historyView),
    versions: (versions?.items ?? [])
      .filter((item) => item.version !== undefined)
      .map((item) => ({
        version: item.version!,
        state: item.status?.state?.state_type,
        updatedAt: item.status?.updated_at,
      }))
      .sort((a, b) => b.version - a.version),
  };
}

export function describeDashboard(dashboard: Dashboard): string {
  const states = (counts: Record<string, number>) =>
    Object.entries(counts)
      .map(([state, count]) => `${count} ${state}`)
      .join(", ") || "none";

  const lastHealth = dashboard.health.points.at(-1);

  return [
    `Workspace ${dashboard.workspaceId}: ${dashboard.nodes.online} of ${dashboard.nodes.total} nodes online.`,
    `Jobs: ${states(dashboard.jobs.byState)}.`,
    `Executions: ${states(dashboard.executions.byState)}.`,
    lastHealth
      ? `Last minute: ${lastHealth.nodesReporting} nodes reporting, average CPU ${lastHealth.cpuAvgPercent ?? "?"}%.`
      : "No recent node heartbeat samples.",
    `Failures in the last ${dashboard.failures.windowHours} h: ${dashboard.failures.total}${
      dashboard.failures.topJobs.length > 0
        ? ` (most from ${dashboard.failures.topJobs
            .map((job) => job.name ?? job.jobId)
            .slice(0, 3)
            .join(", ")})`
        : ""
    }.`,
    ...dashboard.notes,
  ].join("\n");
}

// ---------------------------------------------------------------- helpers

function stateOf(execution: Execution): string {
  return execution.status?.observed_state?.state_type ?? "unknown";
}

async function optional<T>(work: Promise<T>): Promise<T | undefined> {
  try {
    return await work;
  } catch {
    return undefined;
  }
}

function after(iso: string | undefined, since: Date): boolean {
  if (!iso) return false;

  const time = Date.parse(iso);

  return Number.isFinite(time) && time >= since.getTime();
}

function minMax(
  value:
    | { avg_percent?: number; max_percent?: number; min_percent?: number }
    | undefined,
) {
  return {
    avg:
      value?.avg_percent === undefined ? undefined : round(value.avg_percent),
    max:
      value?.max_percent === undefined ? undefined : round(value.max_percent),
    min:
      value?.min_percent === undefined ? undefined : round(value.min_percent),
  };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Hourly buckets from `since` to `now`, counting items by a key. */
function hourly<Item>(
  items: readonly Item[],
  since: Date,
  now: Date,
  timeOf: (item: Item) => string | undefined,
  keyOf: (item: Item) => string,
): TimeBucket[] {
  const start = Math.floor(since.getTime() / 3_600_000) * 3_600_000;
  const buckets: TimeBucket[] = [];

  for (let t = start; t <= now.getTime(); t += 3_600_000) {
    buckets.push({ t: new Date(t).toISOString(), counts: {} });
  }

  for (const item of items) {
    const time = Date.parse(timeOf(item) ?? "");

    if (!Number.isFinite(time) || time < start) continue;

    const bucket = buckets[Math.floor((time - start) / 3_600_000)];

    if (!bucket) continue;

    const key = keyOf(item);

    bucket.counts[key] = (bucket.counts[key] ?? 0) + 1;
  }

  return buckets;
}

/** Executions placed (created) and finished (terminal update) per hour. */
function activityBuckets(
  items: readonly Execution[],
  since: Date,
  now: Date,
): TimeBucket[] {
  const placed = hourly(
    items,
    since,
    now,
    (item) => item.status?.created_at,
    () => "placed",
  );

  const finished = hourly(
    items.filter((item) => FINISHED_STATES.has(stateOf(item))),
    since,
    now,
    (item) => item.status?.updated_at,
    () => "finished",
  );

  return placed.map((bucket, index) => ({
    t: bucket.t,
    counts: { ...bucket.counts, ...finished[index]?.counts },
  }));
}

/** Per-step fleet health from per-node CPU series. */
function cpuSeries(range: QueryRange | undefined, end: number, step: number) {
  const byNode = new Map<string, (number | null)[]>();
  const steps = Math.floor((HEALTH_WINDOW_MINUTES * 60) / step) + 1;
  const start = end - (steps - 1) * step;
  const perStep: number[][] = Array.from({ length: steps }, () => []);

  for (const item of range?.data?.result ?? []) {
    const nodeId = item.metric?.instance ?? item.metric?.service_instance;

    if (!nodeId) continue;

    const values = new Array<number | null>(steps).fill(null);

    for (const [t, raw] of item.values ?? []) {
      const index = Math.round((t - start) / step);
      const value = Number(raw) * 100;

      if (index < 0 || index >= steps || !Number.isFinite(value)) continue;

      values[index] = round(value);
      perStep[index].push(value);
    }

    byNode.set(nodeId, values);
  }

  // Leading steps with no samples at all are before any history exists.
  const first = perStep.findIndex((values) => values.length > 0);

  const points = (first < 0 ? [] : perStep.slice(first)).map(
    (values, offset) => ({
      t: new Date((start + (first + offset) * step) * 1000).toISOString(),
      nodesReporting: values.length,
      cpuAvgPercent:
        values.length > 0
          ? round(values.reduce((sum, value) => sum + value, 0) / values.length)
          : undefined,
      cpuMaxPercent: values.length > 0 ? round(Math.max(...values)) : undefined,
    }),
  );

  return { byNode, points };
}
