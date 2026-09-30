import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../src/cloud/client.js";
import { FILTER_SCAN_LIMIT, listFiltered } from "../src/mcp/fleet.js";
import { jobView } from "../src/mcp/views.js";
import { fakeFetch } from "./helpers.js";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

const job = (n: number, state: string) => ({
  id: `job-${n}`,
  spec: { name: `job-${n}` },
  status: { state: { state_type: state } },
});

/** Serves `total` jobs in pages, with the given job numbers failed. */
function pagedJobs(total: number, failed: Set<number>) {
  const recorded = fakeFetch({
    [`GET ${API}/jobs`]: ({ url }) => {
      const start = Number(url.searchParams.get("next_token") ?? "0");
      const size = Math.min(Number(url.searchParams.get("limit")), 100);
      const end = Math.min(start + size, total);

      const items = Array.from({ length: end - start }, (_, i) =>
        job(start + i, failed.has(start + i) ? "failed" : "running"),
      );

      return Response.json({
        items,
        next_token: end < total ? String(end) : "",
      });
    },
  });

  return {
    ...recorded,
    client: new WorkspaceClient(ENDPOINT, "jwt", recorded.fetch),
  };
}

const failedJobs = (client: WorkspaceClient, limit: number) =>
  listFiltered(
    (page) => client.listJobs(page),
    jobView,
    (view) => view.state === "failed",
    limit,
  );

describe("listFiltered", () => {
  it("keeps reading pages until a match is found past the first page", async () => {
    const { client } = pagedJobs(120, new Set([80]));

    const list = await failedJobs(client, 50);

    expect(list.items.map((view) => view.id)).toEqual(["job-80"]);
    expect(list.more).toBe(false);
    expect(list.partialScan).toBeUndefined();
  });

  it("says how many rows were read when the scan limit leaves rows unread", async () => {
    const { client } = pagedJobs(FILTER_SCAN_LIMIT + 50, new Set([250]));

    const list = await failedJobs(client, 50);

    expect(list.items).toEqual([]);
    expect(list.more).toBe(true);
    expect(list.partialScan).toBe(FILTER_SCAN_LIMIT);
  });

  it("stops once enough rows match", async () => {
    const { client, requests } = pagedJobs(300, new Set([1, 2, 3]));

    const list = await failedJobs(client, 2);

    expect(list.items.map((view) => view.id)).toEqual(["job-1", "job-2"]);
    expect(list.more).toBe(true);
    expect(list.partialScan).toBeUndefined();
    expect(requests).toHaveLength(1);
  });

  it("reads one page of the requested size without a filter", async () => {
    const { client, requests } = pagedJobs(120, new Set());

    const list = await listFiltered(
      (page) => client.listJobs(page),
      jobView,
      undefined,
      10,
    );

    expect(list.items).toHaveLength(10);
    expect(list.more).toBe(true);
    expect(requests[0]?.url.searchParams.get("limit")).toBe("10");
  });
});
