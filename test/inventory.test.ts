import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../src/cloud/client.js";
import {
  collectAll,
  describeInventory,
  trimGroups,
  workspaceInventory,
} from "../src/mcp/inventory.js";
import { fakeFetch, type Route } from "./helpers.js";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

function job(id: string, state: string) {
  return {
    id,
    spec: { name: `job-${id}` },
    status: { state: { state_type: state } },
  };
}

function node(id: string, connection: string) {
  return {
    id,
    spec: { name: `node-${id}` },
    status: { connection_state: connection },
  };
}

/** Serves rows in pages of the requested size, like the orchestrator. */
function paged(rows: object[]): Route {
  return ({ url }) => {
    const start = Number(url.searchParams.get("next_token") ?? "0");
    const limit = Number(url.searchParams.get("limit") ?? "50");
    const end = start + limit;

    return Response.json({
      items: rows.slice(start, end),
      next_token: end < rows.length ? String(end) : "",
    });
  };
}

describe("collectAll", () => {
  it("follows next_token until every row is read", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) =>
      job(`j${i}`, "running"),
    );

    const { fetch, requests } = fakeFetch({ [`GET ${API}/jobs`]: paged(rows) });
    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    const all = await collectAll(
      (page) => client.listJobs(page),
      (item) => item.id,
    );

    expect(all.items).toHaveLength(2500);
    expect(all.truncated).toBe(false);
    expect(requests.map((r) => r.url.searchParams.get("limit"))).toEqual([
      "1000",
      "1000",
      "1000",
    ]);
  });

  it("stops at the cap and says the list is truncated", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => job(`j${i}`, "running"));
    const { fetch } = fakeFetch({ [`GET ${API}/jobs`]: paged(rows) });
    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    const all = await collectAll(
      (page) => client.listJobs(page),
      (item) => item.id,
      20,
    );

    expect(all.items).toHaveLength(20);
    expect(all.truncated).toBe(true);
  });
});

describe("workspaceInventory", () => {
  const routes = {
    [`GET ${API}/jobs`]: paged([
      job("a", "running"),
      job("b", "degraded"),
      job("c", "failed"),
      job("d", "running"),
      job("e", "stopped"),
      job("f", "deleted"),
      job("g", "completed"),
    ]),
    [`GET ${API}/nodes`]: paged([
      node("1", "connected"),
      node("2", "lost"),
      node("3", "connected"),
      node("4", "disconnected"),
      node("5", "deleted"),
    ]),
  };

  const load = () =>
    workspaceInventory(
      new WorkspaceClient(ENDPOINT, "jwt", fakeFetch(routes).fetch),
      "ws1",
      new Date("2026-09-30T20:00:00Z"),
    );

  it("counts healthy and not healthy items, leaving out deleted ones", async () => {
    const inventory = await load();

    expect(inventory.nodes).toMatchObject({
      total: 4,
      healthy: 2,
      notHealthy: 2,
      truncated: false,
    });
    expect(inventory.jobs).toMatchObject({
      total: 6,
      healthy: 3,
      notHealthy: 3,
    });
  });

  it("puts problems first and healthy groups last", async () => {
    const inventory = await load();

    expect(
      inventory.jobs.groups.map((group) => [group.state, group.count]),
    ).toEqual([
      ["failed", 1],
      ["degraded", 1],
      ["stopped", 1],
      ["running", 2],
      ["completed", 1],
    ]);

    expect(inventory.nodes.groups.at(-1)).toMatchObject({
      state: "connected",
      healthy: true,
      count: 2,
    });
  });

  it("answers counts first, then names what is not healthy", async () => {
    const text = describeInventory(await load(), "both");
    const lines = text.split("\n");

    expect(lines[0]).toBe(
      "Nodes: 4 total, 2 healthy (connected), 2 not healthy.",
    );
    expect(text).toContain("- 1 lost: node-2");
    expect(text).not.toContain("node-1");
    expect(text).toContain(
      "Jobs: 6 total, 3 healthy (running or completed), 3 not healthy.",
    );
    expect(text).toContain("- 1 failed: job-c");
  });

  it("can answer about one kind only", async () => {
    const text = describeInventory(await load(), "nodes");

    expect(text).toContain("Nodes:");
    expect(text).not.toContain("Jobs:");
  });

  it("trims long groups but keeps their true count", async () => {
    const inventory = await load();

    const [running] = trimGroups(inventory.jobs.groups, 1).filter(
      (group) => group.state === "running",
    );

    expect(running.items).toHaveLength(1);
    expect(running.count).toBe(2);

    const text = describeInventory(
      {
        ...inventory,
        jobs: {
          ...inventory.jobs,
          groups: trimGroups(inventory.jobs.groups, 1),
        },
      },
      "jobs",
    );

    expect(text).toContain("- 2 running: job-a, and 1 more");
  });
});
