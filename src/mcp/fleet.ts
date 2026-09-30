import type { WorkspaceClient } from "../cloud/client.js";
import type { Page } from "../cloud/types.js";
import type { LinkedWorkspace } from "../account.js";
import type { FleetSummary } from "./contracts.js";

export type { FleetSummary };

import {
  ATTENTION_JOB_STATES,
  ERROR_EXECUTION_STATES,
  countBy,
  executionView,
  jobView,
  nodeView,
} from "./views.js";

const JOB_SAMPLE = 200;

const NODE_SAMPLE = 200;

const LIST_LIMIT = 10;

type FleetClient = Pick<
  WorkspaceClient,
  "nodeStats" | "listNodes" | "listJobs" | "listExecutions"
>;

export async function fleetSummary(
  client: FleetClient,
  workspace: LinkedWorkspace,
  now: Date = new Date(),
): Promise<FleetSummary> {
  const [stats, nodes, jobs, errors] = await Promise.all([
    client.nodeStats(),
    client.listNodes({ limit: NODE_SAMPLE }),
    client.listJobs({ limit: JOB_SAMPLE }),
    client.listExecutions({
      states: [...ERROR_EXECUTION_STATES],
      limit: LIST_LIMIT,
    }),
  ]);

  const nodeViews = (nodes.items ?? []).map(nodeView);

  const byConnectionState =
    stats.nodes_by_connection_state ??
    countBy(nodeViews, (node) => node.connectionState);

  const jobViews = (jobs.items ?? []).map(jobView);

  return {
    workspace: {
      id: workspace.workspaceId,
      name: workspace.name,
      endpoint: workspace.endpoint,
    },
    generatedAt: now.toISOString(),
    nodes: {
      total: stats.total_nodes ?? nodeViews.length,
      online: byConnectionState.connected ?? 0,
      byConnectionState,
      offline: nodeViews
        .filter((node) => !node.online && node.connectionState !== "deleted")
        .slice(0, LIST_LIMIT),
    },
    jobs: {
      counted: jobViews.length,
      more: Boolean(jobs.next_token),
      // The list endpoint cannot filter on "degraded", so states are counted here.
      byState: countBy(jobViews, (job) => job.state),
      needsAttention: jobViews
        .filter((job) => ATTENTION_JOB_STATES.has(job.state))
        .slice(0, LIST_LIMIT),
    },
    recentErrors: (errors.items ?? []).map(executionView),
  };
}

export function describeFleet(summary: FleetSummary): string {
  const jobStates = Object.entries(summary.jobs.byState)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ");

  const lines = [
    `Workspace ${summary.workspace.name ?? summary.workspace.id}: ${summary.nodes.online} of ${summary.nodes.total} nodes online.`,
    `Jobs: ${jobStates || "none"}${summary.jobs.more ? ` (first ${summary.jobs.counted} counted)` : ""}.`,
  ];

  if (summary.jobs.needsAttention.length > 0) {
    lines.push(
      `Needs attention: ${summary.jobs.needsAttention
        .map((job) => `${job.name ?? job.id} (${job.state})`)
        .join(", ")}.`,
    );
  }

  if (summary.recentErrors.length > 0) {
    lines.push(
      `Recent failed, degraded, or lost executions: ${summary.recentErrors.length}.`,
    );
  }

  return lines.join("\n");
}

/** Rows read at most when a list filter has to be applied here. */
export const FILTER_SCAN_LIMIT = 200;

export interface FilteredList<View> {
  items: View[];
  more: boolean;
  /** Rows read. Set only when rows were left unread because of the scan limit. */
  partialScan?: number;
}

/**
 * Reads pages until `limit` rows match or FILTER_SCAN_LIMIT rows were read,
 * so a filter the server cannot apply does not stop at the first page.
 */
export async function listFiltered<Item, View>(
  fetchPage: (options: {
    limit: number;
    nextToken?: string;
  }) => Promise<Page<Item>>,
  toView: (item: Item) => View,
  matches: ((view: View) => boolean) | undefined,
  limit: number,
): Promise<FilteredList<View>> {
  if (!matches) {
    const page = await fetchPage({ limit });

    return {
      items: (page.items ?? []).map(toView),
      more: Boolean(page.next_token),
    };
  }

  const found: View[] = [];
  let scanned = 0;
  let nextToken: string | undefined;

  do {
    const page = await fetchPage({
      limit: FILTER_SCAN_LIMIT - scanned,
      nextToken,
    });

    const items = page.items ?? [];

    scanned += items.length;
    found.push(...items.map(toView).filter(matches));
    nextToken = items.length > 0 ? page.next_token || undefined : undefined;
  } while (nextToken && found.length < limit && scanned < FILTER_SCAN_LIMIT);

  return {
    items: found.slice(0, limit),
    more: Boolean(nextToken) || found.length > limit,
    ...(nextToken && found.length < limit ? { partialScan: scanned } : {}),
  };
}
