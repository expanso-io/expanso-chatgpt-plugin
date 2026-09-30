import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../src/cloud/client.js";
import type { JsonObject, JsonValue } from "../src/cloud/types.js";
import type { TimeBucket } from "../src/mcp/contracts.js";
import {
  DASHBOARD_NOTES,
  jobDashboard,
  nodeDetail,
  workspaceDashboard,
} from "../src/mcp/dashboard.js";
import { fail, fakeFetch, reply, type Route } from "./helpers.js";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

const NOW = new Date("2026-09-30T12:00:00Z");

const END = NOW.getTime() / 1000;

const STATUS: JsonObject = {
  runtime: { version: "1.5.0", status: "running", uptime_seconds: 86400 },
  nodes: { total: 3, by_connection: { connected: 2, lost: 1 } },
  jobs: { total: 7, by_state: { running: 5, failed: 2 } },
  executions: { total: 40, by_state: { running: 30, failed: 10 } },
  evaluations: { ready: 1, inflight: 0, pending: 2, waiting: 0 },
};

const NODE_STATS: JsonObject = {
  total_nodes: 9,
  nodes_by_connection_state: { connected: 6, lost: 3 },
  resource_stats: {
    cpu: { avg_percent: 35.44, max_percent: 50, min_percent: 10 },
    memory: { avg_percent: 60.06, max_percent: 80, min_percent: 40 },
    disk: { avg_percent: 12, max_percent: 20, min_percent: 5 },
  },
};

const node = (id: string, state: string, cpu?: number): JsonObject => ({
  id,
  spec: { name: id },
  status: {
    connection_state: state,
    resource_usage: cpu === undefined ? {} : { cpu_percent: cpu },
  },
});

const NODES: JsonObject = {
  items: [
    node("node-b", "connected", 10),
    node("node-c", "lost"),
    node("node-a", "connected", 30),
  ],
  next_token: "",
};

const JOBS: JsonObject = {
  items: [
    {
      id: "job-1",
      spec: { name: "telemetry" },
      status: { state: { state_type: "running" } },
    },
    {
      id: "job-2",
      spec: { name: "ingest" },
      status: { state: { state_type: "failed" } },
    },
  ],
};

const execution = (
  id: string,
  jobId: string,
  nodeId: string,
  state: string,
  createdAt: string,
  updatedAt: string,
): JsonObject => ({
  id,
  job_id: jobId,
  node_id: nodeId,
  status: {
    observed_state: { state_type: state },
    created_at: createdAt,
    updated_at: updatedAt,
  },
});

const RECENT: JsonObject = {
  items: [
    execution(
      "e1",
      "job-1",
      "node-a",
      "running",
      "2026-09-30T10:15:00Z",
      "2026-09-30T10:20:00Z",
    ),
    execution(
      "e2",
      "job-1",
      "node-b",
      "completed",
      "2026-09-30T10:30:00Z",
      "2026-09-30T11:05:00Z",
    ),
    execution(
      "e3",
      "job-2",
      "node-a",
      "failed",
      "2026-09-30T11:10:00Z",
      "2026-09-30T11:40:00Z",
    ),
    execution(
      "e4",
      "job-2",
      "node-b",
      "completed",
      "2026-09-28T09:00:00Z",
      "2026-09-28T10:00:00Z",
    ),
  ],
};

const FAILURES: JsonObject = {
  items: [
    execution(
      "f1",
      "job-2",
      "node-a",
      "failed",
      "2026-09-30T11:10:00Z",
      "2026-09-30T11:40:00Z",
    ),
    execution(
      "f2",
      "job-2",
      "node-b",
      "lost",
      "2026-09-30T09:00:00Z",
      "2026-09-30T09:30:00Z",
    ),
    execution(
      "f3",
      "job-1",
      "node-a",
      "degraded",
      "2026-09-30T11:00:00Z",
      "2026-09-30T11:50:00Z",
    ),
    execution(
      "f4",
      "job-3",
      "node-c",
      "failed",
      "2026-09-28T09:00:00Z",
      "2026-09-28T10:00:00Z",
    ),
  ],
};

/** One series per node; values are CPU ratios, as the orchestrator serves them. */
const matrix = (
  series: { labels: { [key: string]: string }; values: [number, string][] }[],
): JsonObject => ({
  status: "success",
  data: {
    resultType: "matrix",
    result: series.map(({ labels, values }) => ({
      metric: labels,
      values,
    })),
  },
});

const CPU = matrix([
  {
    labels: { instance: "node-a", job: "orchestrator" },
    values: [
      [END - 120, "0.42"],
      [END - 60, "0.5"],
      [END, "0.3"],
    ],
  },
  {
    labels: { instance: "node-b", job: "orchestrator" },
    values: [
      [END - 60, "0.2"],
      [END, "0.1"],
    ],
  },
]);

/** Answers failure queries (those with ?states=) apart from the recent sample. */
const executions =
  (recent: JsonValue, failures: JsonValue): Route =>
  ({ url }) =>
    Response.json(url.searchParams.has("states") ? failures : recent);

function dashboardClient(overrides: { [key: string]: Route } = {}) {
  const recorded = fakeFetch({
    [`GET ${API}/status`]: reply(STATUS),
    [`GET ${API}/nodes/-/stats`]: reply(NODE_STATS),
    [`GET ${API}/nodes`]: reply(NODES),
    [`GET ${API}/jobs`]: reply(JOBS),
    [`GET ${API}/executions`]: executions(RECENT, FAILURES),
    [`GET ${API}/metrics/query_range`]: reply(CPU),
    ...overrides,
  });

  return {
    ...recorded,
    client: new WorkspaceClient(ENDPOINT, "jwt", recorded.fetch),
  };
}

const bucketAt = (buckets: TimeBucket[], iso: string) =>
  buckets.find((bucket) => bucket.t === new Date(iso).toISOString());

const nonEmpty = (buckets: TimeBucket[]) =>
  buckets.flatMap((bucket) =>
    Object.keys(bucket.counts).length > 0 ? [bucket] : [],
  );

describe("workspaceDashboard", () => {
  it("takes totals, the queue, and the orchestrator from /status", async () => {
    const { client } = dashboardClient();

    const dashboard = await workspaceDashboard(client, "ws-1", NOW);

    expect(dashboard.workspaceId).toBe("ws-1");
    expect(dashboard.generatedAt).toBe(NOW.toISOString());

    expect(dashboard.orchestrator).toEqual({
      version: "1.5.0",
      status: "running",
      uptimeSeconds: 86400,
    });

    expect(dashboard.nodes.total).toBe(3);
    expect(dashboard.nodes.online).toBe(2);
    expect(dashboard.nodes.byConnectionState).toEqual({
      connected: 2,
      lost: 1,
    });

    expect(dashboard.jobs).toEqual({
      total: 7,
      byState: { running: 5, failed: 2 },
    });

    expect(dashboard.executions).toEqual({
      total: 40,
      byState: { running: 30, failed: 10 },
    });

    expect(dashboard.queue).toEqual({
      ready: 1,
      inflight: 0,
      pending: 2,
      waiting: 0,
    });
  });

  it("rounds fleet resource ranges from /nodes/-/stats", async () => {
    const { client } = dashboardClient();

    const dashboard = await workspaceDashboard(client, "ws-1", NOW);

    expect(dashboard.nodes.resources).toEqual({
      cpu: { avg: 35.4, max: 50, min: 10 },
      memory: { avg: 60.1, max: 80, min: 40 },
      disk: { avg: 12, max: 20, min: 5 },
    });
  });

  it("counts nodes reporting per minute and averages their CPU in percent", async () => {
    const { client } = dashboardClient();

    const dashboard = await workspaceDashboard(client, "ws-1", NOW);

    expect(dashboard.health.windowMinutes).toBe(30);
    expect(dashboard.health.stepSeconds).toBe(60);

    expect(dashboard.health.points).toEqual([
      {
        t: new Date((END - 120) * 1000).toISOString(),
        nodesReporting: 1,
        cpuAvgPercent: 42,
        cpuMaxPercent: 42,
      },
      {
        t: new Date((END - 60) * 1000).toISOString(),
        nodesReporting: 2,
        cpuAvgPercent: 35,
        cpuMaxPercent: 50,
      },
      {
        t: NOW.toISOString(),
        nodesReporting: 2,
        cpuAvgPercent: 20,
        cpuMaxPercent: 30,
      },
    ]);
  });

  it("buckets executions placed and finished per hour within the last day", async () => {
    const { client } = dashboardClient();

    const { activity } = await workspaceDashboard(client, "ws-1", NOW);

    expect(activity.windowHours).toBe(24);
    expect(activity.sampled).toBe(4);
    expect(activity.buckets).toHaveLength(25);

    expect(activity.buckets[0].t).toBe("2026-09-29T12:00:00.000Z");
    expect(activity.buckets.at(-1)?.t).toBe(NOW.toISOString());

    expect(nonEmpty(activity.buckets)).toEqual([
      { t: "2026-09-30T10:00:00.000Z", counts: { placed: 2 } },
      { t: "2026-09-30T11:00:00.000Z", counts: { placed: 1, finished: 2 } },
    ]);
  });

  it("buckets failures by state and names the jobs that failed most", async () => {
    const { client } = dashboardClient();

    const { failures } = await workspaceDashboard(client, "ws-1", NOW);

    expect(failures.total).toBe(3);

    expect(bucketAt(failures.buckets, "2026-09-30T09:00:00Z")?.counts).toEqual({
      lost: 1,
    });

    expect(bucketAt(failures.buckets, "2026-09-30T11:00:00Z")?.counts).toEqual({
      failed: 1,
      degraded: 1,
    });

    expect(nonEmpty(failures.buckets)).toHaveLength(2);

    expect(failures.topJobs).toEqual([
      { jobId: "job-2", name: "ingest", count: 2 },
      { jobId: "job-1", name: "telemetry", count: 1 },
    ]);
  });

  it("lists offline nodes first, then by CPU, with per-node series and executions", async () => {
    const { client } = dashboardClient();

    const { topNodes } = await workspaceDashboard(client, "ws-1", NOW);

    expect(topNodes.map((item) => item.id)).toEqual([
      "node-c",
      "node-a",
      "node-b",
    ]);

    const nodeA = topNodes[1];

    expect(nodeA.cpuSeries).toHaveLength(31);
    expect(nodeA.cpuSeries.slice(-3)).toEqual([42, 50, 30]);
    expect(nodeA.cpuSeries[0]).toBeNull();
    expect(nodeA.executions).toEqual({ running: 1, failed: 1 });
    expect(topNodes[0].cpuSeries.every((value) => value === null)).toBe(true);
  });

  it("says throughput is not available", async () => {
    const { client } = dashboardClient();

    const { notes } = await workspaceDashboard(client, "ws-1", NOW);

    expect(notes).toContain(DASHBOARD_NOTES.throughput);
    expect(notes.join(" ")).toMatch(/throughput .* not available/i);
    expect(notes).not.toContain(
      "Node CPU history is unavailable from this workspace.",
    );
  });

  it("asks for the CPU ratio over the last 30 minutes in one-minute steps", async () => {
    const { client, requests } = dashboardClient();

    await workspaceDashboard(client, "ws-1", NOW);

    const query = requests.find(
      (request) => request.url.pathname === "/api/v1/metrics/query_range",
    )?.url.searchParams;

    expect(query?.get("query")).toBe("process_cpu_utilization_ratio");
    expect(query?.get("start")).toBe(String(END - 1800));
    expect(query?.get("end")).toBe(String(END));
    expect(query?.get("step")).toBe("60");
  });

  it("builds from /nodes/-/stats when /status and query_range fail", async () => {
    const { client } = dashboardClient({
      [`GET ${API}/status`]: fail(404, "no status"),
      [`GET ${API}/metrics/query_range`]: fail(404, "no metrics"),
    });

    const dashboard = await workspaceDashboard(client, "ws-1", NOW);

    expect(dashboard.nodes.total).toBe(9);
    expect(dashboard.nodes.online).toBe(6);
    expect(dashboard.nodes.byConnectionState).toEqual({
      connected: 6,
      lost: 3,
    });

    expect(dashboard.jobs).toEqual({
      total: 2,
      byState: { running: 1, failed: 1 },
    });

    expect(dashboard.executions).toEqual({
      total: 4,
      byState: { running: 1, completed: 2, failed: 1 },
    });

    expect(dashboard.orchestrator).toEqual({
      version: undefined,
      status: undefined,
      uptimeSeconds: undefined,
    });

    expect(dashboard.queue).toBeUndefined();
    expect(dashboard.health.points).toEqual([]);
    expect(dashboard.topNodes[1].cpuSeries).toEqual([]);

    expect(dashboard.notes).toContain(
      "Node CPU history is unavailable from this workspace.",
    );
  });

  it("counts nodes from the node list when neither source has counts", async () => {
    const { client } = dashboardClient({
      [`GET ${API}/status`]: fail(404, "no status"),
      [`GET ${API}/nodes/-/stats`]: reply({}),
    });

    const dashboard = await workspaceDashboard(client, "ws-1", NOW);

    expect(dashboard.nodes.total).toBe(3);
    expect(dashboard.nodes.online).toBe(2);
    expect(dashboard.nodes.byConnectionState).toEqual({
      connected: 2,
      lost: 1,
    });

    expect(dashboard.nodes.resources).toBeUndefined();
  });

  it("fails when /nodes/-/stats fails", async () => {
    const { client } = dashboardClient({
      [`GET ${API}/nodes/-/stats`]: fail(500, "stats down"),
    });

    await expect(workspaceDashboard(client, "ws-1", NOW)).rejects.toThrow(
      /stats down/,
    );
  });
});

const NODE_A: JsonObject = {
  node: {
    id: "node-a",
    spec: { name: "edge-a", os: "linux" },
    status: { connection_state: "connected" },
  },
};

const MEMORY = matrix([
  {
    labels: { service_instance: "node-a" },
    values: [
      [END - 60, "1048576"],
      [END, "NaN"],
    ],
  },
]);

/** Serves each metric by name; metrics left out answer 404. */
const metrics =
  (byName: { [name: string]: JsonValue }): Route =>
  ({ url }) => {
    const body = byName[url.searchParams.get("query") ?? ""];

    return body === undefined
      ? Response.json({ message: "unknown metric" }, { status: 404 })
      : Response.json(body);
  };

describe("nodeDetail", () => {
  it("keeps only the node's own series and converts CPU to percent", async () => {
    const { fetch, requests } = fakeFetch({
      [`GET ${API}/nodes/node-a`]: reply(NODE_A),
      [`GET ${API}/executions`]: reply(RECENT),
      [`GET ${API}/metrics/query_range`]: metrics({
        process_cpu_utilization_ratio: CPU,
        process_memory_usage_bytes: MEMORY,
      }),
    });

    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    const detail = await nodeDetail(client, "node-a", NOW);

    expect(detail.node).toMatchObject({
      id: "node-a",
      name: "edge-a",
      online: true,
    });

    expect(detail.resources.windowMinutes).toBe(30);

    expect(detail.resources.points).toEqual([
      { t: new Date((END - 120) * 1000).toISOString(), cpuPercent: 42 },
      {
        t: new Date((END - 60) * 1000).toISOString(),
        cpuPercent: 50,
        memoryBytes: 1048576,
      },
      { t: NOW.toISOString(), cpuPercent: 30 },
    ]);

    const executionQuery = requests.find(
      (request) => request.url.pathname === "/api/v1/executions",
    )?.url.searchParams;

    expect(executionQuery?.getAll("node_ids")).toEqual(["node-a"]);
  });

  it("counts the node's executions by state", async () => {
    const { fetch } = fakeFetch({
      [`GET ${API}/nodes/node-a`]: reply(NODE_A),
      [`GET ${API}/executions`]: reply(RECENT),
    });

    const detail = await nodeDetail(
      new WorkspaceClient(ENDPOINT, "jwt", fetch),
      "node-a",
      NOW,
    );

    expect(detail.executionsByState).toEqual({
      running: 1,
      completed: 2,
      failed: 1,
    });

    expect(detail.executions.map((item) => item.id)).toEqual([
      "e1",
      "e2",
      "e3",
      "e4",
    ]);

    expect(detail.resources.points).toEqual([]);
  });
});

const JOB_1: JsonObject = {
  job: {
    id: "job-1",
    spec: { name: "telemetry", type: "pipeline" },
    status: { state: { state_type: "running" }, version: 3 },
  },
};

/** Newest first, as the orchestrator orders by updated_at desc. */
const JOB_EXECUTIONS: JsonObject = {
  items: [
    execution(
      "x1",
      "job-1",
      "node-a",
      "running",
      "2026-09-30T11:00:00Z",
      "2026-09-30T11:50:00Z",
    ),
    execution(
      "x2",
      "job-1",
      "node-a",
      "failed",
      "2026-09-30T10:00:00Z",
      "2026-09-30T11:00:00Z",
    ),
    execution(
      "x3",
      "job-1",
      "node-b",
      "failed",
      "2026-09-30T09:00:00Z",
      "2026-09-30T10:00:00Z",
    ),
    execution(
      "x4",
      "job-1",
      "node-c",
      "failed",
      "2026-09-28T09:00:00Z",
      "2026-09-28T10:00:00Z",
    ),
  ],
};

const HISTORY: JsonObject = {
  items: [
    {
      timestamp: "2026-09-30T11:50:00Z",
      message: "Execution running",
      execution_id: "x1",
    },
  ],
};

const version = (
  number: number,
  state: string,
  updatedAt: string,
): JsonObject => ({
  version: number,
  spec: { name: "telemetry", type: "pipeline" },
  status: { state: { state_type: state }, updated_at: updatedAt },
});

const VERSIONS: JsonObject = {
  items: [
    version(1, "completed", "2026-09-28T09:00:00Z"),
    version(3, "running", "2026-09-30T11:00:00Z"),
    version(2, "failed", "2026-09-29T09:00:00Z"),
    { spec: { name: "telemetry" } },
  ],
};

function jobClient(overrides: { [key: string]: Route } = {}) {
  const { fetch } = fakeFetch({
    [`GET ${API}/jobs/job-1`]: reply(JOB_1),
    [`GET ${API}/jobs/job-1/executions`]: reply(JOB_EXECUTIONS),
    [`GET ${API}/jobs/job-1/history`]: reply(HISTORY),
    [`GET ${API}/jobs/job-1/versions`]: reply(VERSIONS),
    ...overrides,
  });

  return new WorkspaceClient(ENDPOINT, "jwt", fetch);
}

describe("jobDashboard", () => {
  it("takes each node's state from its newest execution", async () => {
    const dashboard = await jobDashboard(jobClient(), "job-1", NOW);

    expect(dashboard.job).toMatchObject({
      id: "job-1",
      name: "telemetry",
      state: "running",
      version: 3,
    });

    expect(dashboard.nodes).toEqual([
      {
        nodeId: "node-a",
        state: "running",
        message: undefined,
        updatedAt: "2026-09-30T11:50:00Z",
      },
      {
        nodeId: "node-b",
        state: "failed",
        message: undefined,
        updatedAt: "2026-09-30T10:00:00Z",
      },
      {
        nodeId: "node-c",
        state: "failed",
        message: undefined,
        updatedAt: "2026-09-28T10:00:00Z",
      },
    ]);

    expect(dashboard.executionsByState).toEqual({ running: 1, failed: 2 });
  });

  it("buckets failures from the last day only", async () => {
    const dashboard = await jobDashboard(jobClient(), "job-1", NOW);

    expect(nonEmpty(dashboard.failures)).toEqual([
      { t: "2026-09-30T10:00:00.000Z", counts: { failed: 1 } },
      { t: "2026-09-30T11:00:00.000Z", counts: { failed: 1 } },
    ]);
  });

  it("sorts versions newest first and drops versions without a number", async () => {
    const dashboard = await jobDashboard(jobClient(), "job-1", NOW);

    expect(dashboard.versions).toEqual([
      { version: 3, state: "running", updatedAt: "2026-09-30T11:00:00Z" },
      { version: 2, state: "failed", updatedAt: "2026-09-29T09:00:00Z" },
      { version: 1, state: "completed", updatedAt: "2026-09-28T09:00:00Z" },
    ]);
  });

  it("includes the job history", async () => {
    const dashboard = await jobDashboard(jobClient(), "job-1", NOW);

    expect(dashboard.history).toEqual([
      {
        timestamp: "2026-09-30T11:50:00Z",
        message: "Execution running",
        executionId: "x1",
        details: undefined,
      },
    ]);
  });

  it("shows no versions when the versions route fails", async () => {
    const client = jobClient({
      [`GET ${API}/jobs/job-1/versions`]: fail(404, "no versions"),
    });

    const dashboard = await jobDashboard(client, "job-1", NOW);

    expect(dashboard.versions).toEqual([]);
    expect(dashboard.nodes).toHaveLength(3);
  });
});
