import { describe, expect, it } from "vitest";
import type { LinkedWorkspace } from "../src/account.js";
import { CloudApiError } from "../src/cloud/client.js";
import {
  CloudFleetDirectory,
  type DirectoryWorkspace,
  type FleetDirectory,
  type FleetStatus,
} from "../src/cloud/directory.js";
import type { Job, NodeStats, Page } from "../src/cloud/types.js";
import {
  describeFleets,
  fleetsView,
  statusFromWorkspace,
} from "../src/mcp/fleets.js";
import { fail, fakeFetch, reply } from "./helpers.js";

const NOW = new Date("2026-09-30T12:00:00Z");

const CLOUD = "https://cloud.test";

const LINKED: LinkedWorkspace[] = [
  { workspaceId: "ws-b", endpoint: "b.example.com:9010", name: "Beta" },
  { workspaceId: "ws-a", endpoint: "a.example.com:9010", name: "Alpha" },
];

const STATS: NodeStats = {
  total_nodes: 5,
  nodes_by_connection_state: { connected: 3, lost: 1, deleted: 1 },
};

const job = (id: string, state: string, updatedAt?: string): Job => ({
  id,
  spec: { name: id },
  status: { state: { state_type: state }, updated_at: updatedAt },
});

const JOBS: Page<Job> = {
  items: [
    job("j1", "running", "2026-09-30T10:00:00Z"),
    job("j2", "failed", "2026-09-30T11:00:00Z"),
    job("j3", "rollout_failed", "2026-09-30T09:00:00Z"),
    job("j4", "degraded"),
    job("j5", "completed", "2026-09-29T08:00:00Z"),
  ],
};

interface FakeWorkspace {
  stats?: NodeStats;
  jobs?: Page<Job>;
  error?: Error;
}

/** Builds status clients per workspace and records which were asked. */
function clients(byId: { [workspaceId: string]: FakeWorkspace }) {
  const asked: string[] = [];

  const client = async (workspaceId: string) => {
    asked.push(workspaceId);

    const workspace = byId[workspaceId] ?? {};

    if (workspace.error) throw workspace.error;

    return {
      nodeStats: async () => workspace.stats ?? STATS,
      listJobs: async () => workspace.jobs ?? JOBS,
    };
  };

  return { client, asked };
}

function directory(
  workspaces?: DirectoryWorkspace[],
  statuses?: FleetStatus[],
): FleetDirectory {
  return {
    workspaces: async () => workspaces,
    statuses: async () => statuses,
  };
}

describe("statusFromWorkspace", () => {
  it("counts connected nodes as healthy and leaves deleted nodes out", async () => {
    const status = await statusFromWorkspace({
      nodeStats: async () => STATS,
      listJobs: async () => JOBS,
    });

    expect(status).toEqual({
      nodesTotal: 4,
      nodesHealthy: 3,
      nodesUnhealthy: 1,
      jobsTotal: 5,
      jobsRunning: 1,
      jobsFailing: 3,
      jobsCountedFrom: undefined,
      lastActivityAt: "2026-09-30T11:00:00Z",
    });
  });

  it("leaves the job total unset when more jobs remain unread", async () => {
    const status = await statusFromWorkspace({
      nodeStats: async () => STATS,
      listJobs: async () => ({ ...JOBS, next_token: "page-2" }),
    });

    expect(status.jobsTotal).toBeUndefined();
    expect(status.jobsCountedFrom).toBe(5);
  });

  it("handles a workspace with no nodes or jobs", async () => {
    const status = await statusFromWorkspace({
      nodeStats: async () => ({}),
      listJobs: async () => ({}),
    });

    expect(status).toEqual({
      nodesTotal: 0,
      nodesHealthy: 0,
      nodesUnhealthy: 0,
      jobsTotal: 0,
      jobsRunning: 0,
      jobsFailing: 0,
      jobsCountedFrom: undefined,
      lastActivityAt: undefined,
    });
  });
});

describe("fleetsView without a Cloud directory", () => {
  it("shows only linked workspaces, with status from each orchestrator", async () => {
    const { client, asked } = clients({
      "ws-a": { jobs: { ...JOBS, next_token: "page-2" } },
    });

    const view = await fleetsView({
      directory: directory(),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      keyExpiresAt: "2026-12-31T00:00:00Z",
      client,
      now: NOW,
    });

    expect(view.generatedAt).toBe(NOW.toISOString());
    expect(view.directoryAvailable).toBe(false);
    expect(view.activeWorkspaceId).toBe("ws-b");
    expect(asked.sort()).toEqual(["ws-a", "ws-b"]);

    expect(view.fleets.map((fleet) => [fleet.id, fleet.active])).toEqual([
      ["ws-b", true],
      ["ws-a", false],
    ]);

    const [beta, alpha] = view.fleets;

    expect(beta).toMatchObject({
      name: "Beta",
      endpoint: "b.example.com:9010",
      linked: true,
      keyExpiresAt: "2026-12-31T00:00:00Z",
      statusSource: "workspace",
      status: {
        nodesTotal: 4,
        nodesHealthy: 3,
        nodesUnhealthy: 1,
        jobsTotal: 5,
        jobsRunning: 1,
        jobsFailing: 3,
        lastActivityAt: "2026-09-30T11:00:00Z",
      },
    });

    expect(alpha.status?.jobsTotal).toBeUndefined();
    expect(alpha.status?.jobsCountedFrom).toBe(5);
  });

  it("treats a directory that throws like one that is missing", async () => {
    const { client } = clients({});

    const failing: FleetDirectory = {
      workspaces: async () => {
        throw new Error("directory down");
      },
      statuses: async () => {
        throw new Error("directory down");
      },
    };

    const view = await fleetsView({
      directory: failing,
      linked: LINKED,
      activeWorkspaceId: "ws-a",
      client,
      now: NOW,
    });

    expect(view.directoryAvailable).toBe(false);
    expect(view.fleets.map((fleet) => fleet.id)).toEqual(["ws-a", "ws-b"]);
  });

  it("leaves keyExpiresAt unset when the key has no expiry", async () => {
    const { client } = clients({});

    const view = await fleetsView({
      directory: directory(),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      keyExpiresAt: null,
      client,
      now: NOW,
    });

    expect(view.fleets[0].keyExpiresAt).toBeUndefined();
  });

  it("reports a workspace whose status cannot be read", async () => {
    const { client } = clients({
      "ws-a": { error: new Error("The API key has expired.") },
    });

    const view = await fleetsView({
      directory: directory(),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      client,
      now: NOW,
    });

    const alpha = view.fleets.find((fleet) => fleet.id === "ws-a");

    expect(alpha?.status).toBeUndefined();
    expect(alpha?.statusError).toBe("The API key has expired.");
    expect(alpha?.statusSource).toBe("unavailable");
    expect(view.fleets[0].status?.nodesHealthy).toBe(3);
  });

  it("reports a failure inside the status calls the same way", async () => {
    const view = await fleetsView({
      directory: directory(),
      linked: [LINKED[0]],
      activeWorkspaceId: "ws-b",
      client: async () => ({
        nodeStats: async () => {
          throw new CloudApiError("access was denied (HTTP 403)", 403);
        },
        listJobs: async () => JOBS,
      }),
      now: NOW,
    });

    expect(view.fleets[0].statusError).toBe("access was denied (HTTP 403)");
  });
});

describe("fleetsView with a Cloud directory", () => {
  const WORKSPACES: DirectoryWorkspace[] = [
    {
      id: "ws-a",
      name: "Alpha (Cloud)",
      endpoint: "cloud-a.example.com:9010",
      organization_name: "Fixture Org",
      state: "ready",
    },
    { id: "ws-c", name: "Charlie", state: "provisioning" },
    { id: "ws-d", name: "Aardvark", state: "ready" },
  ];

  const STATUSES: FleetStatus[] = [
    {
      workspace_id: "ws-c",
      nodes: { total: 2, healthy: 1, unhealthy: 1 },
      jobs: { total: 3, running: 2, failing: 1 },
      last_activity_at: "2026-09-30T08:00:00Z",
    },
  ];

  it("lists unlinked workspaces and merges linked ones", async () => {
    const { client, asked } = clients({});

    const view = await fleetsView({
      directory: directory(WORKSPACES, STATUSES),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      client,
      now: NOW,
    });

    expect(view.directoryAvailable).toBe(true);

    expect(view.fleets.map((fleet) => fleet.id)).toEqual([
      "ws-b",
      "ws-a",
      "ws-d",
      "ws-c",
    ]);

    const [beta, alpha, aardvark, charlie] = view.fleets;

    expect(beta).toMatchObject({
      name: "Beta",
      linked: true,
      active: true,
      statusSource: "workspace",
    });

    expect(alpha).toMatchObject({
      name: "Alpha (Cloud)",
      endpoint: "a.example.com:9010",
      organizationName: "Fixture Org",
      cloudState: "ready",
      linked: true,
      active: false,
      statusSource: "workspace",
    });

    expect(charlie).toMatchObject({
      name: "Charlie",
      linked: false,
      active: false,
      cloudState: "provisioning",
      statusSource: "cloud",
      status: {
        nodesTotal: 2,
        nodesHealthy: 1,
        nodesUnhealthy: 1,
        jobsTotal: 3,
        jobsRunning: 2,
        jobsFailing: 1,
        lastActivityAt: "2026-09-30T08:00:00Z",
      },
    });

    expect(aardvark).toMatchObject({
      linked: false,
      statusSource: "unavailable",
    });

    expect(aardvark.status).toBeUndefined();
    expect(asked.sort()).toEqual(["ws-a", "ws-b"]);
  });

  it("prefers Cloud's status for a linked workspace when Cloud has one", async () => {
    const { client, asked } = clients({});

    const view = await fleetsView({
      directory: directory(WORKSPACES, [
        { ...STATUSES[0], workspace_id: "ws-a" },
      ]),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      client,
      now: NOW,
    });

    const alpha = view.fleets.find((fleet) => fleet.id === "ws-a");

    expect(alpha?.statusSource).toBe("cloud");
    expect(alpha?.status?.nodesTotal).toBe(2);
    expect(asked).toEqual(["ws-b"]);
  });
});

describe("CloudFleetDirectory", () => {
  const workspace = { id: "ws-a", name: "Alpha", endpoint: "a.example:9010" };

  const status = {
    workspace_id: "ws-a",
    nodes: { total: 2, healthy: 2, unhealthy: 0 },
  };

  const directoryWith = (routes: Parameters<typeof fakeFetch>[0]) => {
    const recorded = fakeFetch(routes);

    return {
      ...recorded,
      directory: new CloudFleetDirectory(
        CLOUD,
        async () => "cloud-token",
        recorded.fetch,
      ),
    };
  };

  it("reports itself unavailable when Cloud answers 404", async () => {
    const { directory } = directoryWith({});

    await expect(directory.workspaces()).resolves.toBeUndefined();
    await expect(directory.statuses()).resolves.toBeUndefined();
  });

  it("reads lists under workspaces or items", async () => {
    const named = directoryWith({
      [`GET ${CLOUD}/api/v1/workspaces`]: reply({ workspaces: [workspace] }),
      [`GET ${CLOUD}/api/v1/workspaces/status`]: reply({ items: [status] }),
    });

    await expect(named.directory.workspaces()).resolves.toEqual([workspace]);
    await expect(named.directory.statuses()).resolves.toEqual([status]);

    const generic = directoryWith({
      [`GET ${CLOUD}/api/v1/workspaces`]: reply({ items: [workspace] }),
      [`GET ${CLOUD}/api/v1/workspaces/status`]: reply({
        workspaces: [status],
      }),
    });

    await expect(generic.directory.workspaces()).resolves.toEqual([workspace]);

    await expect(generic.directory.statuses()).resolves.toEqual([status]);
  });

  it("treats a body it cannot read like a missing route", async () => {
    const { directory } = directoryWith({
      [`GET ${CLOUD}/api/v1/workspaces`]: reply({ workspaces: "none" }),
    });

    await expect(directory.workspaces()).resolves.toBeUndefined();
  });

  it("throws CloudApiError on a server error", async () => {
    const { directory } = directoryWith({
      [`GET ${CLOUD}/api/v1/workspaces`]: fail(500, "boom"),
    });

    const error = await directory.workspaces().then(
      () => undefined,
      (caught: Error) => caught,
    );

    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ status: 500 });
    expect(error?.message).toContain("HTTP 500");
  });

  it("sends the connection's token and a User-Agent", async () => {
    const { directory, requests } = directoryWith({
      [`GET ${CLOUD}/api/v1/workspaces`]: reply({ workspaces: [] }),
    });

    await directory.workspaces();

    expect(requests[0].method).toBe("GET");
    expect(requests[0].headers.get("authorization")).toBe("Bearer cloud-token");

    expect(requests[0].headers.get("user-agent")).toMatch(
      /^expanso-fleet-mcp\//,
    );
  });
});

describe("describeFleets", () => {
  it("names active and connected fleets and notes the missing directory", async () => {
    const { client } = clients({
      "ws-a": { error: new Error("key expired") },
    });

    const view = await fleetsView({
      directory: directory(),
      linked: LINKED,
      activeWorkspaceId: "ws-b",
      client,
      now: NOW,
    });

    const text = describeFleets(view);

    expect(text).toContain("2 fleets.");

    expect(text).toContain(
      "- Beta (active, connected): 3 of 4 nodes healthy, 1 jobs running, 3 failing.",
    );

    expect(text).toContain("- Alpha (connected): key expired.");
    expect(text).toContain("does not list other workspaces yet");
  });

  it("marks unlinked fleets and drops the note once the directory exists", async () => {
    const { client } = clients({});

    const view = await fleetsView({
      directory: directory([{ id: "ws-c", name: "Charlie" }]),
      linked: [LINKED[0]],
      activeWorkspaceId: "ws-b",
      client,
      now: NOW,
    });

    const text = describeFleets(view);

    expect(text).toContain("- Charlie (not connected): no status.");
    expect(text).not.toContain("does not list other workspaces yet");
  });
});
