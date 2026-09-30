import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../src/cloud/client.js";
import {
  MENTION_LIMIT,
  parseMentionQuery,
  searchMentions,
} from "../src/mcp/mentions.js";
import { fakeFetch, serve } from "./helpers.js";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

function client() {
  const recorded = fakeFetch({
    [`GET ${API}/jobs`]: serve("jobs.json"),
    [`GET ${API}/nodes`]: serve("nodes.json"),
  });

  return {
    ...recorded,
    client: new WorkspaceClient(ENDPOINT, "jwt", recorded.fetch),
  };
}

describe("parseMentionQuery", () => {
  it("narrows to jobs or nodes with a leading keyword", () => {
    expect(parseMentionQuery("job ingest")).toEqual({
      kinds: ["job"],
      prefix: "ingest",
    });
    expect(parseMentionQuery("nodes:edge")).toEqual({
      kinds: ["node"],
      prefix: "edge",
    });
    expect(parseMentionQuery("job")).toEqual({ kinds: ["job"], prefix: "" });
    expect(parseMentionQuery(" edge-0 ")).toEqual({
      kinds: ["job", "node"],
      prefix: "edge-0",
    });
  });
});

describe("searchMentions", () => {
  it("returns stable expanso:// resource links for jobs and nodes", async () => {
    const { client: c, requests } = client();
    const items = await searchMentions(c, "ws1", "in");
    expect(requests.map((r) => r.url.searchParams.get("prefix"))).toEqual([
      "in",
      "in",
    ]);
    expect(items[0]).toEqual({
      type: "resource_link",
      uri: "expanso://workspaces/ws1/jobs/job-ingest-7f3a",
      name: "ingest-sensors",
      title: "Job ingest-sensors",
      description: "pipeline, degraded",
      mimeType: "text/markdown",
    });

    const node = items.find(
      (item) =>
        item.type === "resource_link" &&
        item.uri.endsWith("/nodes/node-edge-02"),
    );

    expect(node).toMatchObject({
      uri: "expanso://workspaces/ws1/nodes/node-edge-02",
      description: "lost",
    });
  });

  it("queries only jobs for @job", async () => {
    const { client: c, requests } = client();
    const items = await searchMentions(c, "ws1", "job ");
    expect(requests.map((r) => r.url.pathname)).toEqual(["/api/v1/jobs"]);
    expect(
      items.every(
        (item) => item.type === "resource_link" && item.uri.includes("/jobs/"),
      ),
    ).toBe(true);
  });

  it("returns nothing for prefixes Expanso cannot match, without calling it", async () => {
    const { client: c, requests } = client();
    expect(await searchMentions(c, "ws1", 'x"}')).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it("caps the number of results", async () => {
    const many = () =>
      Response.json({
        items: Array.from({ length: 30 }, (_, i) => ({
          id: `job-${i}`,
          status: {},
        })),
      });

    const recorded = fakeFetch({
      [`GET ${API}/jobs`]: many,
      [`GET ${API}/nodes`]: many,
    });

    const items = await searchMentions(
      new WorkspaceClient(ENDPOINT, "jwt", recorded.fetch),
      "ws1",
      "",
    );

    expect(items.length).toBeLessThanOrEqual(MENTION_LIMIT);
  });
});
