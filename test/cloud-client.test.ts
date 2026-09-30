import { describe, expect, it } from "vitest";
import {
  CloudApiError,
  WorkspaceClient,
  decodeClaims,
  exchangeApiKey,
  toQueryString,
} from "../src/cloud/client.js";
import { fail, fakeFetch, fixtureToken, serve, serveToken } from "./helpers.js";

const CLOUD = "https://cloud.test";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

const KEY = "exp_ak_fixture_key_value";

describe("exchangeApiKey", () => {
  it("exchanges an API key for an orchestrator token and reads its claims", async () => {
    const { fetch, requests } = fakeFetch({
      [`POST ${CLOUD}/api/v1/auth/token`]: serveToken("claims-org-wide.json"),
    });

    const token = await exchangeApiKey(CLOUD, KEY, fetch);

    expect(requests[0].headers.get("authorization")).toBe(`Bearer ${KEY}`);

    // Cloud's edge firewall blocks requests that carry no User-Agent.
    expect(requests[0].headers.get("user-agent")).toMatch(
      /^expanso-fleet-mcp\//,
    );

    expect(token.claims).toEqual({
      sub: "usr_fixture_1",
      email: "operator@example.com",
      organizationId: "org_fixture",
      networkId: "*",
    });

    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3500_000);
  });

  it("rejects values that are not Expanso API keys without calling Cloud", async () => {
    const { fetch, requests } = fakeFetch({});

    await expect(
      exchangeApiKey(CLOUD, "sk-not-expanso", fetch),
    ).rejects.toThrow(/start with exp_ak_/);

    expect(requests).toHaveLength(0);
  });

  it("reports a rejected key without echoing it", async () => {
    const { fetch } = fakeFetch({
      [`POST ${CLOUD}/api/v1/auth/token`]: fail(
        401,
        "Invalid or expired API key",
      ),
    });

    const error = await exchangeApiKey(CLOUD, KEY, fetch).then(
      () => undefined,
      (caught: Error) => caught,
    );

    expect(error).toBeInstanceOf(CloudApiError);
    expect(error).toMatchObject({ status: 401 });
    expect(error?.message).toContain("access was denied");
    expect(error?.message).not.toContain(KEY);
  });

  it("rejects a token response without an access token", async () => {
    const { fetch } = fakeFetch({
      [`POST ${CLOUD}/api/v1/auth/token`]: () => Response.json({}),
    });

    await expect(exchangeApiKey(CLOUD, KEY, fetch)).rejects.toMatchObject({
      status: 502,
    });
  });

  it("reads a workspace-bound key's network claim", () => {
    expect(
      decodeClaims(fixtureToken("claims-workspace-bound.json")).networkId,
    ).toBe("ws1");
  });

  it("refuses a token without an organization", () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u" })).toString(
      "base64url",
    );

    expect(() => decodeClaims(`h.${payload}.s`)).toThrow(/organization/);
  });
});

describe("WorkspaceClient", () => {
  const routes = {
    [`GET ${API}/nodes/stats`]: serve("node-stats.json"),
    [`GET ${API}/nodes`]: serve("nodes.json"),
    [`GET ${API}/jobs`]: serve("jobs.json"),
    [`GET ${API}/jobs/job-ingest-7f3a`]: serve("job.json"),
    [`GET ${API}/executions`]: serve("executions-errors.json"),
    [`GET ${API}/executions/exec-aa01/history`]: serve(
      "execution-history.json",
    ),
  };

  it("sends the orchestrator token to the workspace endpoint", async () => {
    const { fetch, requests } = fakeFetch(routes);
    const client = new WorkspaceClient(ENDPOINT, "jwt-fixture", fetch);
    const stats = await client.nodeStats();

    expect(stats.total_nodes).toBe(4);
    expect(requests[0].url.href).toBe(`${API}/nodes/stats`);

    expect(requests[0].headers.get("authorization")).toBe("Bearer jwt-fixture");
  });

  it("encodes list filters the way the orchestrator expects", async () => {
    const { fetch, requests } = fakeFetch(routes);
    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    const page = await client.listExecutions({
      states: ["failed", "degraded", "lost"],
      limit: 10,
    });

    expect(page.items?.[0].id).toBe("exec-aa01");

    const url = requests[0].url;

    expect(url.searchParams.getAll("states")).toEqual([
      "failed",
      "degraded",
      "lost",
    ]);

    expect(url.searchParams.get("order_by")).toBe("updated_at");
    expect(url.searchParams.get("order")).toBe("desc");
    expect(url.searchParams.get("limit")).toBe("10");
  });

  it("parses detail responses and drops fields it does not read", async () => {
    const { fetch } = fakeFetch(routes);
    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);
    const job = await client.getJob("job-ingest-7f3a");

    expect(job.status?.state?.state_type).toBe("degraded");

    const jobs = await client.listJobs();

    expect(JSON.stringify(jobs)).not.toContain("must-not-leak");

    const history = await client.executionHistory("exec-aa01");

    expect(history.items).toHaveLength(2);
  });

  it("refuses IDs that could change the request path", async () => {
    const { fetch, requests } = fakeFetch(routes);
    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    await expect(client.getJob("../nodes")).rejects.toThrow(
      /unsupported characters/,
    );

    await expect(client.getNode("a/b")).rejects.toThrow(
      /unsupported characters/,
    );

    expect(requests).toHaveLength(0);
  });

  it("maps orchestrator errors to a CloudApiError", async () => {
    const { fetch } = fakeFetch({
      [`GET ${API}/jobs/missing-job`]: fail(404, "job not found"),
    });

    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    await expect(client.getJob("missing-job")).rejects.toMatchObject({
      status: 404,
      message: expect.stringContaining("job not found"),
    });
  });

  it("rejects a response that is not the expected shape", async () => {
    const { fetch } = fakeFetch({
      [`GET ${API}/nodes`]: () => Response.json({ items: "nope" }),
    });

    const client = new WorkspaceClient(ENDPOINT, "jwt", fetch);

    await expect(client.listNodes()).rejects.toMatchObject({ status: 502 });
  });
});

describe("toQueryString", () => {
  it("repeats array keys and drops empty values", () => {
    expect(
      toQueryString({
        states: ["a", "b"],
        prefix: "",
        limit: 5,
        x: undefined,
      }),
    ).toBe("?states=a&states=b&limit=5");

    expect(toQueryString({})).toBe("");
  });
});
