import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { z } from "zod";
import { Account } from "../src/account.js";
import type { Env } from "../src/config.js";
import { buildServer } from "../src/mcp/server.js";
import {
  TEST_ENCRYPTION_KEY,
  fakeFetch,
  reply,
  serve,
  serveToken,
} from "./helpers.js";

const CLOUD = "https://cloud.test";

const WS1 = "ws1.us1.cloud.expanso.io:9010";

const WS2 = "ws2.us1.cloud.expanso.io:9010";

const CallSchema = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string() })),
  structuredContent: z.record(z.string(), z.json()).optional(),
});

const NextSchema = z.object({
  next: z.object({
    tool: z.string(),
    arguments: z.record(z.string(), z.json()),
  }),
});

let platform: PlatformProxy<Env>;

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false });
});

afterAll(async () => {
  await platform?.dispose();
});

const routesFor = (endpoint: string) => ({
  [`GET https://${endpoint}/api/v1/jobs/job-ingest-7f3a`]: serve("job.json"),
  [`GET https://${endpoint}/api/v1/jobs/job-ingest-7f3a/executions`]: reply({
    items: [{ id: "ex-1", node_id: "node-a" }],
  }),
  [`POST https://${endpoint}/api/v1/jobs/job-ingest-7f3a/stop`]: reply({
    job_id: "job-ingest-7f3a",
  }),
});

async function connect(accountId: string, workspaces: string[]) {
  const cloud = fakeFetch({
    [`POST ${CLOUD}/api/v1/auth/token`]: serveToken("claims-org-wide.json"),
    ...routesFor(WS1),
    ...routesFor(WS2),
  });

  const account = new Account(
    { accountId, organizationId: "org_fixture" },
    {
      kv: platform.env.OAUTH_KV,
      encryptionKey: TEST_ENCRYPTION_KEY,
      cloudUrl: CLOUD,
      publicBaseUrl: "https://fleet.test",
      consoleUrl: "https://console.test",
      fetch: cloud.fetch,
    },
  );

  if (workspaces.length > 0) {
    await account.store.replaceAll(
      workspaces.map((endpoint) => ({
        workspaceId: endpoint.split(".")[0],
        endpoint,
        apiKey: "exp_ak_fixture_key_value",
      })),
      workspaces[0].split(".")[0],
    );
  }

  const server = buildServer({
    account,
    connections: await account.connections(),
    scopes: ["fleet", "logs"],
    appHtml: "<html></html>",
    iconSvg: "<svg></svg>",
  });

  const client = new Client({ name: "test", version: "0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

  await server.connect(serverSide);
  await client.connect(clientSide);

  const call = async (
    name: string,
    args: z.infer<typeof NextSchema>["next"]["arguments"],
  ) =>
    // Over the wire the result is JSON; the in-memory transport skips that.
    CallSchema.parse(
      JSON.parse(
        JSON.stringify(await client.callTool({ name, arguments: args })),
      ),
    );

  const stops = () =>
    cloud.requests.filter(
      (request) =>
        request.method === "POST" && request.url.pathname.endsWith("/stop"),
    );

  return { call, stops, client };
}

describe("changes and the active workspace", () => {
  it("refuses a change when another workspace became active after its preview", async () => {
    const { call, stops, client } = await connect("acct-switch", [WS1, WS2]);

    const preview = await call("preview_change", {
      action: "stop_job",
      jobId: "job-ingest-7f3a",
    });

    const { next } = NextSchema.parse(preview.structuredContent);

    expect(next.arguments.workspaceId).toBe("ws1");

    await call("switch_workspace", { workspaceId: "ws2" });

    const refused = await call(next.tool, next.arguments);

    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain(
      "previewed for workspace ws1, but the active workspace is now ws2",
    );
    expect(stops()).toHaveLength(0);

    await call("switch_workspace", { workspaceId: "ws1" });

    const stopped = await call(next.tool, next.arguments);

    expect(stopped.isError).not.toBe(true);
    expect(stops()).toHaveLength(1);
    expect(stops()[0].url.host).toBe(WS1);

    await client.close();
  });

  it("answers with the connect link when no workspace is connected", async () => {
    const { call, stops, client } = await connect("acct-empty", []);

    const preview = await call("preview_change", {
      action: "stop_job",
      jobId: "job-ingest-7f3a",
    });

    expect(preview.isError).not.toBe(true);
    expect(preview.structuredContent).toMatchObject({
      connection: { status: "not_connected" },
    });
    expect(preview.content[0].text).toContain("Connect one here:");
    expect(stops()).toHaveLength(0);

    await client.close();
  });
});
