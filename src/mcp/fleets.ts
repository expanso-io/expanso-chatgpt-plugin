import type { WorkspaceClient } from "../cloud/client.js";
import type { Connection } from "../connections.js";
import type {
  DirectoryWorkspace,
  FleetDirectory,
  FleetStatus,
} from "../cloud/directory.js";
import type { FleetsView, FleetView, FleetStatusView } from "./contracts.js";
import { jobView } from "./views.js";

/** Jobs read per workspace when Cloud has no status route yet. */
const STATUS_JOB_SAMPLE = 200;

/** Job states counted as failing in a fleet status. */
const FAILING_JOB_STATES = new Set(["failed", "rollout_failed", "degraded"]);

type StatusClient = Pick<WorkspaceClient, "nodeStats" | "listJobs">;

export interface FleetsInput {
  directory: FleetDirectory;
  /** The workspaces this connection holds a cached key for. */
  connections: readonly Connection[];
  /**
   * Opens the active workspace. Expanso Fleet reads one workspace at a time,
   * so only the active one is asked for its status directly.
   */
  activeClient: () => Promise<StatusClient>;
  now?: Date;
}

/**
 * Every workspace this person can reach, marked with which ones this
 * connection holds a key for and which is active, each with a status
 * summary when one can be read.
 */
export async function fleetsView(input: FleetsInput): Promise<FleetsView> {
  const now = input.now ?? new Date();
  const connected = new Set(input.connections.map((item) => item.workspaceId));
  const active = input.connections.find((item) => item.active);

  const [listed, statuses] = await Promise.all([
    input.directory.workspaces().catch(() => undefined),
    input.directory.statuses().catch(() => undefined),
  ]);

  const byId = new Map<string, FleetView>();

  for (const workspace of listed ?? []) {
    byId.set(workspace.id, fromDirectory(workspace, connected, active));
  }

  for (const connection of input.connections) {
    const known = byId.get(connection.workspaceId);

    byId.set(connection.workspaceId, {
      ...known,
      id: connection.workspaceId,
      name: known?.name ?? connection.name,
      endpoint: connection.endpoint,
      linked: true,
      active: connection.active,
      needsReconnect: connection.needsReconnect,
      keyExpiresAt: connection.keyExpiresAt,
      statusSource: "unavailable",
    });
  }

  const cloudStatus = new Map(
    (statuses ?? []).map((status) => [status.workspace_id, status]),
  );

  const fleets = await Promise.all(
    [...byId.values()].map(async (fleet) => {
      const fromCloud = cloudStatus.get(fleet.id);

      if (fromCloud) {
        return {
          ...fleet,
          status: statusFromCloud(fromCloud),
          statusSource: "cloud" as const,
        };
      }

      // Without Cloud's status route, only the active workspace is read.
      if (!fleet.active || fleet.needsReconnect) return fleet;

      try {
        return {
          ...fleet,
          status: await statusFromWorkspace(await input.activeClient()),
          statusSource: "workspace" as const,
        };
      } catch (error) {
        return {
          ...fleet,
          statusError:
            error instanceof Error ? error.message : "Status is unavailable.",
        };
      }
    }),
  );

  return {
    generatedAt: now.toISOString(),
    directoryAvailable: listed !== undefined,
    activeWorkspaceId: active?.workspaceId,
    fleets: fleets.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        Number(b.linked) - Number(a.linked) ||
        (a.name ?? a.id).localeCompare(b.name ?? b.id),
    ),
  };
}

function fromDirectory(
  workspace: DirectoryWorkspace,
  connected: ReadonlySet<string>,
  active: Connection | undefined,
): FleetView {
  return {
    id: workspace.id,
    name: workspace.name,
    organizationName: workspace.organization_name,
    endpoint: workspace.endpoint,
    cloudState: workspace.state,
    linked: connected.has(workspace.id),
    active: workspace.id === active?.workspaceId,
    needsReconnect: false,
    statusSource: "unavailable",
  };
}

function statusFromCloud(status: FleetStatus): FleetStatusView {
  return {
    nodesTotal: status.nodes?.total,
    nodesHealthy: status.nodes?.healthy,
    nodesUnhealthy: status.nodes?.unhealthy,
    jobsTotal: status.jobs?.total,
    jobsRunning: status.jobs?.running,
    jobsFailing: status.jobs?.failing,
    lastActivityAt: status.last_activity_at,
  };
}

/** The same summary, read from the workspace's own orchestrator. */
export async function statusFromWorkspace(
  client: StatusClient,
): Promise<FleetStatusView> {
  const [stats, jobs] = await Promise.all([
    client.nodeStats(),
    client.listJobs({ limit: STATUS_JOB_SAMPLE }),
  ]);

  const byState = stats.nodes_by_connection_state ?? {};
  const total = stats.total_nodes ?? 0;
  const healthy = byState.connected ?? 0;
  const deleted = byState.deleted ?? 0;
  const views = (jobs.items ?? []).map(jobView);

  const lastActivityAt = views
    .map((job) => job.updatedAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1);

  return {
    nodesTotal: total - deleted,
    nodesHealthy: healthy,
    nodesUnhealthy: Math.max(0, total - deleted - healthy),
    jobsTotal: jobs.next_token ? undefined : views.length,
    jobsRunning: views.filter((job) => job.state === "running").length,
    jobsFailing: views.filter((job) => FAILING_JOB_STATES.has(job.state))
      .length,
    jobsCountedFrom: jobs.next_token ? views.length : undefined,
    lastActivityAt,
  };
}

export function describeFleets(view: FleetsView): string {
  const lines = view.fleets.map((fleet) => {
    const status = fleet.status;

    const tags = [
      fleet.active ? "active" : undefined,
      fleet.linked ? "connected" : "not connected",
      fleet.needsReconnect ? "needs reconnecting" : undefined,
    ].filter(Boolean);

    const summary = status
      ? `${status.nodesHealthy ?? "?"} of ${status.nodesTotal ?? "?"} nodes healthy, ${status.jobsRunning ?? "?"} jobs running, ${status.jobsFailing ?? "?"} failing`
      : (fleet.statusError ?? "no status");

    return `- ${fleet.name ?? fleet.id} (${tags.join(", ")}): ${summary}.`;
  });

  const note = view.directoryAvailable
    ? ""
    : "\nExpanso Cloud does not list other workspaces yet; showing the workspaces this connection links.";

  return `${view.fleets.length} fleets.\n${lines.join("\n")}${note}`;
}
