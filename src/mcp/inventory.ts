import type { WorkspaceClient } from "../cloud/client.js";
import type { Page } from "../cloud/types.js";
import type {
  InventoryGroup,
  JobView,
  NodeView,
  WorkspaceInventory,
} from "./contracts.js";
import { jobView, nodeView } from "./views.js";

/** Rows fetched per orchestrator page (its maximum is 1000). */
const PAGE_SIZE = 1000;

/** Rows read per kind before giving up; past this the result says so. */
export const INVENTORY_CAP = 5000;

/** Node connection states that count as healthy. */
const HEALTHY_NODE_STATES = new Set(["connected"]);

/** Job states that count as healthy. */
const HEALTHY_JOB_STATES = new Set(["running", "completed"]);

/** Job states that need someone to look, listed first. */
const ATTENTION_JOB_ORDER = ["failed", "rollout_failed", "degraded", "queued"];

export interface Collected<View> {
  items: View[];
  /** True when INVENTORY_CAP rows were read and more remain. */
  truncated: boolean;
}

/** Follows next_token until every row is read or the cap is reached. */
export async function collectAll<Item, View>(
  fetchPage: (options: {
    limit: number;
    nextToken?: string;
  }) => Promise<Page<Item>>,
  toView: (item: Item) => View,
  cap = INVENTORY_CAP,
): Promise<Collected<View>> {
  const items: View[] = [];
  let nextToken: string | undefined;

  do {
    const page = await fetchPage({
      limit: Math.min(PAGE_SIZE, cap - items.length),
      nextToken,
    });

    const rows = page.items ?? [];

    items.push(...rows.map(toView));
    nextToken = rows.length > 0 ? page.next_token || undefined : undefined;
  } while (nextToken && items.length < cap);

  return { items, truncated: Boolean(nextToken) };
}

function isHealthyNode(node: NodeView): boolean {
  return HEALTHY_NODE_STATES.has(node.connectionState);
}

function isHealthyJob(job: JobView): boolean {
  return HEALTHY_JOB_STATES.has(job.state);
}

function stateRank(state: string, healthy: boolean): number {
  const attention = ATTENTION_JOB_ORDER.indexOf(state);

  if (attention >= 0) return attention;

  return healthy ? 100 : 50;
}

/** Groups by state: problems first, then other states, healthy last. */
function groupByState<View>(
  items: readonly View[],
  stateOf: (item: View) => string,
  healthy: (item: View) => boolean,
): InventoryGroup<View>[] {
  const groups = new Map<string, View[]>();

  for (const item of items) {
    const state = stateOf(item);
    const group = groups.get(state);

    if (group) group.push(item);
    else groups.set(state, [item]);
  }

  return [...groups.entries()]
    .map(([state, members]) => ({
      state,
      healthy: healthy(members[0]),
      count: members.length,
      items: members,
    }))
    .sort(
      (a, b) =>
        stateRank(a.state, a.healthy) - stateRank(b.state, b.healthy) ||
        b.count - a.count,
    );
}

/** Every job and node in a workspace, grouped by health and state. */
export async function workspaceInventory(
  client: Pick<WorkspaceClient, "listJobs" | "listNodes">,
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceInventory> {
  const [jobs, nodes] = await Promise.all([
    collectAll((page) => client.listJobs(page), jobView),
    collectAll((page) => client.listNodes(page), nodeView),
  ]);

  const liveNodes = nodes.items.filter(
    (node) => node.connectionState !== "deleted",
  );

  const liveJobs = jobs.items.filter((job) => job.state !== "deleted");
  const healthyNodes = liveNodes.filter(isHealthyNode).length;
  const healthyJobs = liveJobs.filter(isHealthyJob).length;

  return {
    workspaceId,
    generatedAt: now.toISOString(),
    jobs: {
      total: liveJobs.length,
      healthy: healthyJobs,
      notHealthy: liveJobs.length - healthyJobs,
      truncated: jobs.truncated,
      groups: groupByState(liveJobs, (job) => job.state, isHealthyJob),
    },
    nodes: {
      total: liveNodes.length,
      healthy: healthyNodes,
      notHealthy: liveNodes.length - healthyNodes,
      truncated: nodes.truncated,
      groups: groupByState(
        liveNodes,
        (node) => node.connectionState,
        isHealthyNode,
      ),
    },
  };
}

/** Caps each group for a model-facing answer, keeping the true counts. */
export function trimGroups<View>(
  groups: readonly InventoryGroup<View>[],
  perGroup: number,
): InventoryGroup<View>[] {
  return groups.map((group) => ({
    ...group,
    items: group.items.slice(0, perGroup),
  }));
}

function nameOf(item: { id: string; name?: string }): string {
  return item.name ?? item.id;
}

function describeGroups<View extends { id: string; name?: string }>(
  groups: readonly InventoryGroup<View>[],
  onlyUnhealthy: boolean,
): string[] {
  return groups.flatMap((group) => {
    if (onlyUnhealthy && group.healthy) return [];

    const names = group.items.map(nameOf).join(", ");
    const rest = group.count - group.items.length;

    return [
      `- ${group.count} ${group.state.replace(/_/g, " ")}: ${names}${rest > 0 ? `, and ${rest} more` : ""}`,
    ];
  });
}

/** Counts first, then the items that are not healthy by name. */
export function describeInventory(
  inventory: WorkspaceInventory,
  include: "jobs" | "nodes" | "both",
): string {
  const lines: string[] = [];
  const { jobs, nodes } = inventory;

  if (include !== "jobs") {
    lines.push(
      `Nodes: ${nodes.total} total, ${nodes.healthy} healthy (connected), ${nodes.notHealthy} not healthy${nodes.truncated ? " (first rows only)" : ""}.`,
      ...describeGroups(nodes.groups, true),
    );
  }

  if (include !== "nodes") {
    lines.push(
      `Jobs: ${jobs.total} total, ${jobs.healthy} healthy (running or completed), ${jobs.notHealthy} not healthy${jobs.truncated ? " (first rows only)" : ""}.`,
      ...describeGroups(jobs.groups, false),
    );
  }

  return lines.join("\n");
}
