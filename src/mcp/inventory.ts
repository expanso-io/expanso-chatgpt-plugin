import type { WorkspaceClient } from "../cloud/client.js";
import type { Page } from "../cloud/types.js";
import type {
  InventoryGroup,
  InventoryPage,
  JobView,
  KindInventory,
  NodeView,
  WorkspaceInventory,
} from "./contracts.js";
import { sortGroups } from "./groups.js";
import { jobView, nodeView } from "./views.js";

/** Rows fetched per orchestrator page (its maximum is 1000). */
const PAGE_SIZE = 1000;

/** Rows read per kind per call; past this the result carries a nextToken. */
export const INVENTORY_CAP = 5000;

/** Node connection states that count as healthy. */
const HEALTHY_NODE_STATES = new Set(["connected"]);

/** Job states that count as healthy. */
const HEALTHY_JOB_STATES = new Set(["running", "completed"]);

type InventoryClient = Pick<
  WorkspaceClient,
  "listJobs" | "listNodes" | "nodeStats"
>;

export type InventoryKind = "jobs" | "nodes";

export interface Collected<View> {
  items: View[];
  /** Set when the cap was reached and more rows remain. */
  nextToken?: string;
}

/** Follows next_token until every row is read or the cap is reached. */
export async function collectAll<Item, View>(
  fetchPage: (options: {
    limit: number;
    nextToken?: string;
  }) => Promise<Page<Item>>,
  toView: (item: Item) => View,
  cap = INVENTORY_CAP,
  startToken?: string,
): Promise<Collected<View>> {
  const items: View[] = [];
  let nextToken = startToken;

  do {
    const page = await fetchPage({
      limit: Math.min(PAGE_SIZE, cap - items.length),
      nextToken,
    });

    const rows = page.items ?? [];

    items.push(...rows.map(toView));
    nextToken = rows.length > 0 ? page.next_token || undefined : undefined;
  } while (nextToken && items.length < cap);

  return { items, nextToken };
}

function isHealthyNode(node: NodeView): boolean {
  return HEALTHY_NODE_STATES.has(node.connectionState);
}

function isHealthyJob(job: JobView): boolean {
  return HEALTHY_JOB_STATES.has(job.state);
}

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

  return sortGroups(
    [...groups.entries()].map(([state, members]) => ({
      state,
      healthy: healthy(members[0]),
      count: members.length,
      items: members,
    })),
  );
}

function summarize<View>(
  collected: Collected<View>,
  stateOf: (item: View) => string,
  healthy: (item: View) => boolean,
): KindInventory<View> {
  const live = collected.items.filter((item) => stateOf(item) !== "deleted");
  const healthyCount = live.filter(healthy).length;

  return {
    total: live.length,
    healthy: healthyCount,
    notHealthy: live.length - healthyCount,
    countsComplete: collected.nextToken === undefined,
    nextToken: collected.nextToken,
    groups: groupByState(live, stateOf, healthy),
  };
}

const jobState = (job: JobView) => job.state;

const nodeState = (node: NodeView) => node.connectionState;

async function loadJobs(
  client: InventoryClient,
  startToken?: string,
): Promise<KindInventory<JobView>> {
  const jobs = await collectAll(
    (page) => client.listJobs(page),
    jobView,
    INVENTORY_CAP,
    startToken,
  );

  return summarize(jobs, jobState, isHealthyJob);
}

async function loadNodes(
  client: InventoryClient,
  startToken?: string,
): Promise<KindInventory<NodeView>> {
  const nodes = summarize(
    await collectAll(
      (page) => client.listNodes(page),
      nodeView,
      INVENTORY_CAP,
      startToken,
    ),
    nodeState,
    isHealthyNode,
  );

  if (nodes.countsComplete || startToken) return nodes;

  // Node stats cover the whole workspace, so the counts stay exact past the cap.
  const byState = (await client.nodeStats()).nodes_by_connection_state;

  if (!byState) return nodes;

  const total = Object.entries(byState)
    .filter(([state]) => state !== "deleted")
    .reduce((sum, [, count]) => sum + count, 0);

  const healthy = [...HEALTHY_NODE_STATES].reduce(
    (sum, state) => sum + (byState[state] ?? 0),
    0,
  );

  return {
    ...nodes,
    total,
    healthy,
    notHealthy: total - healthy,
    countsComplete: true,
  };
}

/** Every job and node in a workspace, grouped by health and state. */
export async function workspaceInventory(
  client: InventoryClient,
  workspaceId: string,
  now: Date = new Date(),
): Promise<WorkspaceInventory> {
  const [jobs, nodes] = await Promise.all([
    loadJobs(client),
    loadNodes(client),
  ]);

  return { workspaceId, generatedAt: now.toISOString(), jobs, nodes };
}

/** The next rows of one kind, continuing from a nextToken. */
export async function inventoryPage(
  client: InventoryClient,
  workspaceId: string,
  kind: InventoryKind,
  nextToken: string,
  now: Date = new Date(),
): Promise<InventoryPage> {
  const page: InventoryPage = { workspaceId, generatedAt: now.toISOString() };

  if (kind === "jobs") page.jobs = await loadJobs(client, nextToken);
  else page.nodes = await loadNodes(client, nextToken);

  return page;
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

function partial(inventory: KindInventory<unknown>): string {
  return inventory.countsComplete
    ? ""
    : " (counts cover only the rows loaded so far; the workspace has more)";
}

function nodeCounts(nodes: WorkspaceInventory["nodes"]): string {
  return `Nodes: ${nodes.total} total, ${nodes.healthy} healthy (connected), ${nodes.notHealthy} not healthy${partial(nodes)}.`;
}

function jobCounts(jobs: WorkspaceInventory["jobs"]): string {
  return `Jobs: ${jobs.total} total, ${jobs.healthy} healthy (running or completed), ${jobs.notHealthy} not healthy${partial(jobs)}.`;
}

/** Count lines only, for results whose items are read by the app. */
export function describeCounts(inventory: InventoryPage): string {
  const lines: string[] = [];

  if (inventory.nodes) lines.push(nodeCounts(inventory.nodes));

  if (inventory.jobs) lines.push(jobCounts(inventory.jobs));

  return lines.join("\n");
}

/** Counts first, then the items that are not healthy by name. */
export function describeInventory(
  inventory: WorkspaceInventory,
  include: "jobs" | "nodes" | "both",
): string {
  const lines: string[] = [];
  const { jobs, nodes } = inventory;

  if (include !== "jobs") {
    lines.push(nodeCounts(nodes), ...describeGroups(nodes.groups, true));
  }

  if (include !== "nodes") {
    lines.push(jobCounts(jobs), ...describeGroups(jobs.groups, false));
  }

  return lines.join("\n");
}
