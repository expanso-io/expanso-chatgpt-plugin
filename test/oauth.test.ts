import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Account } from "../src/account.js";
import type { Env } from "../src/config.js";
import { buildServer } from "../src/mcp/server.js";
import { apiKeysPageUrl } from "../src/config.js";
import {
  LinkError,
  linkAccount,
  opaqueAccountId,
} from "../src/oauth/authorize.js";
import { linkPage } from "../src/oauth/page.js";
import worker from "../src/worker.js";
import {
  TEST_ENCRYPTION_KEY,
  fail,
  fakeFetch,
  reply,
  serve,
  serveToken,
  type RecordedRequest,
} from "./helpers.js";

const BASE = "https://fleet.test";

const CLOUD = "https://cloud.test";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

const API_KEY = "exp_ak_fixture_secret_value";

const REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect";

const config = {
  publicBaseUrl: BASE,
  cloudUrl: CLOUD,
  consoleUrl: "https://console.test",
  endpointSuffixes: [".expanso.io"],
  connectApi: false,
};

function cloudRoutes(claims = "claims-org-wide.json") {
  return {
    [`POST ${CLOUD}/api/v1/auth/token`]: serveToken(claims),
    [`GET ${API}/nodes/-/stats`]: serve("node-stats.json"),
    [`GET ${API}/nodes`]: serve("nodes.json"),
    // The fixture advertises a second page; that page is empty.
    [`GET ${API}/jobs`]: (request: RecordedRequest) =>
      request.url.searchParams.get("next_token")
        ? Response.json({ items: [] })
        : serve("jobs.json")(request),
    [`GET ${API}/executions`]: serve("executions-errors.json"),
  };
}

describe("linkAccount", () => {
  it("checks the key with Cloud, probes the workspace, and keeps the key out of the grant", async () => {
    const { fetch, requests } = fakeFetch(cloudRoutes());

    const { identity, connection } = await linkAccount(
      API_KEY,
      ` https://${ENDPOINT} `,
      {
        config,
        encryptionKey: TEST_ENCRYPTION_KEY,
        fetch,
      },
    );

    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/v1/auth/token",
      "GET /api/v1/nodes/-/stats",
    ]);

    expect(connection).toEqual({
      workspaceId: "ws1",
      endpoint: ENDPOINT,
      apiKey: API_KEY,
    });

    expect(identity).toEqual({
      accountId: await opaqueAccountId("org_fixture", "usr_fixture_1"),
      organizationId: "org_fixture",
      email: "operator@example.com",
    });
  });

  it("takes exactly one workspace endpoint", async () => {
    const { fetch, requests } = fakeFetch(cloudRoutes());

    const deps = { config, encryptionKey: TEST_ENCRYPTION_KEY, fetch };

    await expect(linkAccount(API_KEY, "  ", deps)).rejects.toThrow(
      "Enter the workspace endpoint.",
    );

    await expect(
      linkAccount(API_KEY, `${ENDPOINT}\nws2.us1.cloud.expanso.io:9010`, deps),
    ).rejects.toThrow(/is not an Expanso workspace endpoint/);

    expect(requests).toHaveLength(0);
  });

  it("refuses endpoints outside Expanso before any network call", async () => {
    const { fetch, requests } = fakeFetch(cloudRoutes());

    for (const endpoint of [
      "169.254.169.254",
      "evil.example.com:9010",
      "ws1.us1.expanso.io.evil.com",
      "user@ws1.us1.cloud.expanso.io",
      "ws1.us1.cloud.expanso.io/path",
    ]) {
      await expect(
        linkAccount(API_KEY, endpoint, {
          config,
          encryptionKey: TEST_ENCRYPTION_KEY,
          fetch,
        }),
      ).rejects.toThrow();
    }

    expect(requests).toHaveLength(0);
  });

  it("refuses a workspace-bound key for another workspace", async () => {
    const { fetch } = fakeFetch(cloudRoutes("claims-workspace-bound.json"));

    await expect(
      linkAccount(API_KEY, "ws2.us1.cloud.expanso.io:9010", {
        config,
        encryptionKey: TEST_ENCRYPTION_KEY,
        fetch,
      }),
    ).rejects.toThrow(
      /created for workspace ws1, so it cannot open workspace ws2/,
    );
  });

  it("refuses a workspace that does not accept the key", async () => {
    const { fetch } = fakeFetch({
      ...cloudRoutes(),
      [`GET ${API}/nodes/-/stats`]: fail(403, "forbidden"),
    });

    await expect(
      linkAccount(API_KEY, ENDPOINT, {
        config,
        encryptionKey: TEST_ENCRYPTION_KEY,
        fetch,
      }),
    ).rejects.toThrow(/Workspace ws1 rejected this API key/);
  });
});

describe("linkAccount errors", () => {
  const link = (apiKey: string, endpoints: string, routes = cloudRoutes()) => {
    const recorded = fakeFetch(routes);

    return {
      recorded,
      result: linkAccount(apiKey, endpoints, {
        config,
        encryptionKey: TEST_ENCRYPTION_KEY,
        fetch: recorded.fetch,
      }).then(
        () => undefined,
        (caught: LinkError) => caught,
      ),
    };
  };

  it("says when the pasted value is not an API key, without calling Cloud", async () => {
    const { recorded, result } = link("sk-something-else", ENDPOINT);
    const error = await result;

    expect(error?.field).toBe("api_key");
    expect(error?.message).toMatch(/not an Expanso API key/);
    expect(recorded.requests).toHaveLength(0);
  });

  it("names a mistyped endpoint and shows the expected shape", async () => {
    const error = await link(API_KEY, "https://cloud.expanso.io/acme").result;

    expect(error?.field).toBe("endpoint");
    expect(error?.message).toMatch(/is not an Expanso workspace endpoint/);
    expect(error?.message).toContain("cloud.expanso.io:9010");
  });

  it.each([
    [401, /does not recognize this API key/],
    [403, /refused this API key \(HTTP 403\)/],
    [502, /could not check the key \(HTTP 502\)/],
  ])("explains a Cloud %i when checking the key", async (status, message) => {
    const error = await link(API_KEY, ENDPOINT, {
      ...cloudRoutes(),
      [`POST ${CLOUD}/api/v1/auth/token`]: fail(status, "nope"),
    }).result;

    expect(error?.field).toBe("api_key");
    expect(error?.message).toMatch(message);
    expect(error?.message).not.toContain(API_KEY);
  });

  it("says when Cloud cannot be reached", async () => {
    const recorded = fakeFetch({});

    const error = await linkAccount(API_KEY, ENDPOINT, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch: () => Promise.reject(new TypeError("network down")),
    }).then(
      () => undefined,
      (caught: LinkError) => caught,
    );

    expect(recorded.requests).toHaveLength(0);
    expect(error?.message).toMatch(/could not be reached to check the key/);
  });

  it("says when the workspace endpoint does not answer", async () => {
    const error = await link(API_KEY, ENDPOINT, {
      ...cloudRoutes(),
      [`GET ${API}/nodes/-/stats`]: fail(404, "no route"),
    }).result;

    expect(error?.field).toBe("endpoint");
    expect(error?.message).toMatch(
      /could not be read at that endpoint \(it answered HTTP 404\)/,
    );
  });

  it("says when the workspace answers in a shape it cannot read", async () => {
    const error = await link(API_KEY, ENDPOINT, {
      ...cloudRoutes(),
      [`GET ${API}/nodes/-/stats`]: () =>
        Response.json({ total_nodes: "many" }),
    }).result;

    expect(error?.field).toBe("endpoint");
    expect(error?.message).toMatch(/answered, but not in a form/);
  });

  it("says when the workspace gives no answer", async () => {
    const cloud = fakeFetch(cloudRoutes());

    const error = await linkAccount(API_KEY, ENDPOINT, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch: (input, init) =>
        input.includes("/api/v1/nodes/-/stats")
          ? Promise.reject(new TypeError("network down"))
          : cloud.fetch(input, init),
    }).then(
      () => undefined,
      (caught: LinkError) => caught,
    );

    expect(error?.message).toMatch(/there was no answer/);
  });
});

describe("apiKeysPageUrl", () => {
  it("links the console until a workspace is known", () => {
    expect(apiKeysPageUrl("https://cloud.expanso.io")).toBe(
      "https://cloud.expanso.io/",
    );
  });

  it("links a workspace's Keys page when its slugs are known", () => {
    expect(
      apiKeysPageUrl("https://cloud.expanso.io", {
        orgSlug: "acme",
        workspaceSlug: "edge west",
      }),
    ).toBe("https://cloud.expanso.io/acme/workspaces/edge%20west/keys");
  });
});

describe("linking page", () => {
  const details = {
    clientId: "c",
    clientName: "ChatGPT",
    redirectUri: "https://chatgpt.com/cb",
    redirectHost: "chatgpt.com",
    redirectIsLoopback: false,
    scope: ["fleet"],
  };

  it("offers a Get my key button that opens Expanso Cloud in a new tab", () => {
    const html = linkPage(details, "h", {
      apiKeysUrl: "https://cloud.expanso.io/",
    });

    expect(html).toMatch(
      /<a class="button" href="https:\/\/cloud\.expanso\.io\/" target="_blank" rel="noopener noreferrer">Get my key from Expanso Cloud<\/a>/,
    );

    expect(html).toContain("No expiry");
    expect(html).toContain("full access to its workspace");
    expect(html).toContain("asks you to confirm every change");
    expect(html.toLowerCase()).not.toContain("read-only");
  });

  it("asks for one workspace endpoint in a single-line field", () => {
    const html = linkPage(details, "h", {
      endpoint: "ws1.us1.cloud.expanso.io",
    });

    expect(html).toMatch(
      /<input id="endpoint" name="endpoint" type="text" required[^>]*value="ws1\.us1\.cloud\.expanso\.io"/,
    );
    expect(html).not.toContain("<textarea");
  });

  it("leaves the button out when no key page is configured", () => {
    expect(linkPage(details, "h")).not.toContain("Get my key");
  });

  it("marks the field an error is about", () => {
    const html = linkPage(details, "h", {
      error: "bad endpoint",
      errorField: "endpoint",
    });

    expect(html).toMatch(/id="endpoint"[^>]*aria-invalid="true"/);
    expect(html).not.toMatch(/id="api_key"[^>]*aria-invalid/);
  });

  it("escapes everything a client can choose", () => {
    const html = linkPage(
      {
        clientId: "c",
        clientName: "<script>alert(1)</script>",
        redirectUri: "https://evil.example/cb",
        redirectHost: 'evil.example"><img src=x>',
        redirectIsLoopback: false,
        scope: ["fleet", '"><b>'],
      },
      'h"andle',
    );

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain('"><img');
    expect(html).not.toContain('"><b>');
    expect(html).toContain("&#60;script&#62;");
  });
});

// End to end through the Worker entry point with real local KV from wrangler:
// dynamic client registration, PKCE, the linking page, the token endpoint,
// and authenticated MCP calls. Expanso Cloud is faked at the fetch boundary.
const RegistrationSchema = z.object({ client_id: z.string() });

const TokenSchema = z.object({ access_token: z.string(), scope: z.string() });

const ToolListSchema = z.object({
  result: z.object({
    tools: z.array(
      z.object({
        name: z.string(),
        annotations: z
          .object({ readOnlyHint: z.boolean(), destructiveHint: z.boolean() })
          .partial()
          .optional(),
      }),
    ),
  }),
});

const ToolCallSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ text: z.string() })),
  }),
});

const PreviewCallSchema = z.object({
  result: z.object({
    content: z.array(z.object({ text: z.string() })),
    structuredContent: z.object({
      next: z.object({
        tool: z.string(),
        arguments: z.record(z.string(), z.json()),
      }),
    }),
  }),
});

const FleetCallSchema = z.object({
  result: z.object({
    structuredContent: z.object({
      nodes: z.object({ online: z.number(), total: z.number() }),
      jobs: z.object({ byState: z.record(z.string(), z.number()) }),
    }),
  }),
});

describe("OAuth front door", () => {
  let platform: PlatformProxy<Env>;

  let env: Env;

  beforeAll(async () => {
    platform = await getPlatformProxy<Env>({ persist: false });

    env = {
      ...platform.env,
      LINK_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
      PUBLIC_BASE_URL: BASE,
      EXPANSO_CLOUD_URL: CLOUD,
    };
  });

  afterAll(async () => {
    await platform?.dispose();
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", fakeFetch(cloudRoutes()).fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = (path: string, init?: RequestInit) =>
    worker.fetch(
      new Request(`${BASE}${path}`, init),
      env,
      // SAFETY: the OAuth provider only calls waitUntil and
      // passThroughOnException on the context. Wrangler's local context
      // implements both, and no tool path reads tracing or exports.
      platform.ctx as ExecutionContext,
    );

  async function register(): Promise<string> {
    const response = await call("/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    });

    expect(response.status).toBe(201);

    return RegistrationSchema.parse(await response.json()).client_id;
  }

  async function pkce() {
    const verifier = Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64url");

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );

    return { verifier, challenge: Buffer.from(digest).toString("base64url") };
  }

  function authorizeQuery(
    clientId: string,
    challenge: string,
    overrides: Record<string, string> = {},
  ): string {
    return new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      scope: "fleet logs",
      state: "state-123",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${BASE}/mcp`,
      ...overrides,
    }).toString();
  }

  async function authorize(
    clientId: string,
    challenge: string,
    form: Record<string, string>,
  ) {
    const query = authorizeQuery(clientId, challenge);
    const page = await call(`/authorize?${query}`);

    expect(page.status).toBe(200);

    const html = await page.text();
    const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";

    expect(handle).not.toBe("");

    const cookies = page.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0])
      .join("; ");

    const body = new URLSearchParams({ handle, ...form });

    body.append("scope", "fleet");
    body.append("scope", "logs");

    return call(`/authorize?${query}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: cookies,
        Origin: BASE,
      },
      body,
    });
  }

  it("publishes MCP authorization metadata with S256 and issuer identification", async () => {
    const resource = await call("/.well-known/oauth-protected-resource/mcp");

    expect(await resource.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });

    const server = await (
      await call("/.well-known/oauth-authorization-server")
    ).json();

    expect(server).toMatchObject({
      issuer: BASE,
      code_challenge_methods_supported: ["S256"],
      authorization_response_iss_parameter_supported: true,
      registration_endpoint: `${BASE}/oauth/register`,
    });
  });

  it("challenges unauthenticated MCP requests", async () => {
    const response = await call("/mcp", { method: "POST", body: "{}" });

    expect(response.status).toBe(401);

    expect(response.headers.get("WWW-Authenticate")).toContain(
      "resource_metadata=",
    );
  });

  it("refuses an unregistered redirect URI without redirecting", async () => {
    const clientId = await register();
    const { challenge } = await pkce();

    const response = await call(
      `/authorize?${authorizeQuery(clientId, challenge, { redirect_uri: "https://evil.example/cb" })}`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
  });

  it("requires PKCE", async () => {
    const clientId = await register();
    const query = new URLSearchParams(authorizeQuery(clientId, "x"));

    query.delete("code_challenge");
    query.delete("code_challenge_method");

    const response = await call(`/authorize?${query.toString()}`);

    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toContain("error=invalid_request");
  });

  it("re-shows the page on a bad key and never echoes the key", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        [`POST ${CLOUD}/api/v1/auth/token`]: fail(
          401,
          "Invalid or expired API key",
        ),
      }).fetch,
    );

    const clientId = await register();
    const { challenge } = await pkce();

    const response = await authorize(clientId, challenge, {
      decision: "approve",
      api_key: API_KEY,
      endpoint: ENDPOINT,
    });

    expect(response.status).toBe(400);

    const html = await response.text();

    expect(html).toContain("Expanso Cloud does not recognize this API key");
    expect(html).toMatch(/id="api_key"[^>]*aria-invalid="true"/);
    expect(html).not.toContain(API_KEY);
  });

  it("links the key, issues a token for the PKCE verifier only, and serves fleet tools", async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();

    const approved = await authorize(clientId, challenge, {
      decision: "approve",
      api_key: API_KEY,
      endpoint: ENDPOINT,
    });

    expect(approved.status).toBe(302);

    const location = new URL(approved.headers.get("Location") ?? "");

    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT);
    expect(location.searchParams.get("state")).toBe("state-123");
    expect(location.searchParams.get("iss")).toBe(BASE);

    const code = location.searchParams.get("code") ?? "";

    // The API key is never stored in plaintext in KV.
    const { keys } = await env.OAUTH_KV.list();

    for (const { name } of keys) {
      expect(await env.OAUTH_KV.get(name)).not.toContain(API_KEY);
    }

    const exchange = (codeVerifier: string) =>
      call("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: REDIRECT,
          client_id: clientId,
          code_verifier: codeVerifier,
          resource: `${BASE}/mcp`,
        }),
      });

    const wrong = await exchange(
      "wrong-verifier-wrong-verifier-wrong-verifier-000",
    );

    expect(wrong.status).toBe(400);

    const issued = await exchange(verifier);

    expect(issued.status).toBe(200);

    const tokens = TokenSchema.parse(await issued.json());

    expect(tokens.scope.split(" ").sort()).toEqual(["fleet", "logs"]);

    const rpc = (
      id: number,
      method: string,
      params: JSONRPCRequest["params"] = {},
    ) =>
      call("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${tokens.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });

    const init = await rpc(1, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });

    expect(init.status).toBe(200);

    const { tools } = ToolListSchema.parse(
      await (await rpc(2, "tools/list")).json(),
    ).result;

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [
        "delete_job",
        "delete_node",
        "deploy_job",
        "fleet.dashboard",
        "fleet.inventory",
        "fleet.open",
        "fleet.summary",
        "fleet_dashboard",
        "fleet_overview",
        "fleets.list",
        "get_execution",
        "get_job",
        "get_job_logs",
        "get_job_spec",
        "get_node",
        "get_profile",
        "job_dashboard",
        "list_executions",
        "list_jobs",
        "list_nodes",
        "list_workspaces",
        "node_dashboard",
        "pause_rollout",
        "preview_change",
        "recent_errors",
        "rerun_job",
        "resume_rollout",
        "rollback_job",
        "search_mentions",
        "settings.read",
        "settings.update",
        "stop_job",
        "switch_workspace",
        "add_workspace",
        "disconnect_workspace",
      ].sort(),
    );

    // Every tool that changes Expanso says so, so ChatGPT asks the user to
    // confirm; the destructive ones say that too. The workspace tools change
    // only this plugin's own record of which workspaces are connected;
    // settings.update comes from the settings helper, which sets no
    // annotations. Everything else only reads.
    const pluginStateTools = new Set([
      "switch_workspace",
      "add_workspace",
      "disconnect_workspace",
    ]);

    const writes = new Map([
      ["deploy_job", true],
      ["stop_job", true],
      ["rerun_job", false],
      ["delete_job", true],
      ["rollback_job", true],
      ["pause_rollout", false],
      ["resume_rollout", false],
      ["delete_node", true],
    ]);

    for (const tool of tools) {
      if (tool.name === "settings.update") continue;

      const destructive = writes.get(tool.name);

      expect(tool.annotations?.readOnlyHint, tool.name).toBe(
        destructive === undefined && !pluginStateTools.has(tool.name),
      );

      if (destructive !== undefined) {
        expect(tool.annotations?.destructiveHint, tool.name).toBe(destructive);
      }
    }

    const overview = await (
      await rpc(4, "tools/call", { name: "fleet_overview", arguments: {} })
    ).text();

    // Counts come first, taken from every listed job and node.
    expect(overview).toContain(
      "Nodes: 2 total, 1 healthy (connected), 1 not healthy.",
    );
    expect(overview).toContain(
      "Jobs: 3 total, 1 healthy (running or completed), 2 not healthy.",
    );

    const fleetText = await (
      await rpc(3, "tools/call", { name: "fleet.open", arguments: {} })
    ).text();

    expect(fleetText).not.toContain("must-not-leak");

    const fleet = FleetCallSchema.parse(JSON.parse(fleetText));

    expect(fleet.result.structuredContent.nodes).toMatchObject({
      online: 3,
      total: 4,
    });

    expect(fleet.result.structuredContent.jobs.byState).toEqual({
      degraded: 1,
      running: 1,
      failed: 1,
    });

    // A change runs only with the preview's own arguments.
    const control = fakeFetch({
      ...cloudRoutes(),
      [`GET ${API}/jobs/job-ingest-7f3a`]: serve("job.json"),
      [`GET ${API}/jobs/job-ingest-7f3a/executions`]: reply({
        items: [{ id: "ex-1", node_id: "node-a" }],
      }),
      [`POST ${API}/jobs/job-ingest-7f3a/stop`]: reply({
        job_id: "job-ingest-7f3a",
      }),
    });

    vi.stubGlobal("fetch", control.fetch);

    const previewCall = PreviewCallSchema.parse(
      await (
        await rpc(5, "tools/call", {
          name: "preview_change",
          arguments: { action: "stop_job", jobId: "job-ingest-7f3a" },
        })
      ).json(),
    );

    const next = previewCall.result.structuredContent.next;

    expect(next.tool).toBe("stop_job");
    expect(previewCall.result.content[0].text).toContain(
      'DESTRUCTIVE: Stop job "ingest-sensors"',
    );

    const stops = () =>
      control.requests.filter(
        (request) =>
          request.method === "POST" && request.url.pathname.endsWith("/stop"),
      );

    const tampered = ToolCallSchema.parse(
      await (
        await rpc(6, "tools/call", {
          name: "stop_job",
          arguments: { ...next.arguments, jobId: "job-other" },
        })
      ).json(),
    );

    expect(tampered.result.isError).toBe(true);
    expect(stops()).toHaveLength(0);

    const stopped = ToolCallSchema.parse(
      await (
        await rpc(7, "tools/call", {
          name: "stop_job",
          arguments: next.arguments,
        })
      ).json(),
    );

    expect(stopped.result.isError).not.toBe(true);
    expect(stopped.result.content[0].text).toContain("Done. Stop job");
    expect(stops()).toHaveLength(1);
  });

  const ToolTextSchema = z.object({
    result: z.object({
      content: z.array(z.object({ type: z.literal("text"), text: z.string() })),
    }),
  });

  const LinkResultSchema = z.object({
    result: z.object({ structuredContent: z.object({ url: z.string() }) }),
  });

  const ConnectionResultSchema = z.object({
    result: z.object({
      structuredContent: z.object({
        connection: z.object({
          status: z.enum(["not_connected", "reconnect"]),
          workspaceId: z.string().optional(),
          reconnectUrl: z.string(),
        }),
      }),
    }),
  });

  const WorkspacesSchema = z.object({
    result: z.object({
      structuredContent: z.object({
        workspaces: z.array(
          z.object({
            workspaceId: z.string(),
            active: z.boolean(),
            needsReconnect: z.boolean(),
          }),
        ),
      }),
    }),
  });

  /** Signs in through the whole OAuth flow and returns an MCP caller. */
  async function signIn(endpoint = ENDPOINT) {
    const clientId = await register();
    const { verifier, challenge } = await pkce();

    const approved = await authorize(clientId, challenge, {
      decision: "approve",
      api_key: API_KEY,
      endpoint,
    });

    expect(approved.status).toBe(302);

    const code =
      new URL(approved.headers.get("Location") ?? "").searchParams.get(
        "code",
      ) ?? "";

    const issued = await call("/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
      }),
    });

    const { access_token: accessToken } = TokenSchema.parse(
      await issued.json(),
    );

    let id = 0;

    const rpc = async (method: string, params: JSONRPCRequest["params"]) => {
      id += 1;

      const response = await call("/mcp", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "MCP-Protocol-Version": "2025-11-25",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      });

      return response.text();
    };

    const tool = (name: string, args: Record<string, string> = {}) =>
      rpc("tools/call", { name, arguments: args });

    return Object.assign(tool, { rpc });
  }

  const MentionsSchema = z.object({
    result: z.object({
      structuredContent: z.object({ items: z.array(z.unknown()) }),
    }),
  });

  const RpcErrorSchema = z.object({
    error: z.object({ message: z.string() }),
  });

  const addLinkCount = async () =>
    (await env.OAUTH_KV.list({ prefix: "app:addlink:" })).keys.length;

  const ENDPOINT_2 = "ws2.us1.cloud.expanso.io:9010";

  const API_2 = `https://${ENDPOINT_2}/api/v1`;

  const text = (reply: string) =>
    ToolTextSchema.parse(JSON.parse(reply)).result.content[0].text;

  /** Submits the add-workspace form behind a one-time link. */
  async function submitLink(url: string, form: Record<string, string>) {
    const link = new URL(url);

    return call(link.pathname, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: link.searchParams.get("token") ?? "",
        ...form,
      }),
    });
  }

  it("connects, switches, and disconnects workspaces, one active at a time", async () => {
    vi.stubGlobal(
      "fetch",
      fakeFetch({
        ...cloudRoutes(),
        [`GET ${API_2}/nodes/-/stats`]: serve("node-stats.json"),
      }).fetch,
    );

    const tool = await signIn();

    const { url } = LinkResultSchema.parse(
      JSON.parse(await tool("add_workspace")),
    ).result.structuredContent;

    const linkUrl = new URL(url);

    expect(`${linkUrl.origin}${linkUrl.pathname}`).toBe(
      `${BASE}/workspaces/add`,
    );

    const page = await call(`${linkUrl.pathname}${linkUrl.search}`);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain('name="endpoint"');

    const connected = await submitLink(url, {
      api_key: API_KEY,
      endpoint: ENDPOINT_2,
    });

    expect(connected.status).toBe(200);
    expect(await connected.text()).toContain("Workspace ws2 is connected");

    // The link is spent.
    const again = await submitLink(url, {
      api_key: API_KEY,
      endpoint: ENDPOINT_2,
    });

    expect(again.status).toBe(410);

    const listed = () =>
      tool("list_workspaces").then(
        (reply: string) =>
          WorkspacesSchema.parse(JSON.parse(reply)).result.structuredContent
            .workspaces,
      );

    expect(
      (await listed()).map((item) => [item.workspaceId, item.active]).sort(),
    ).toEqual([
      ["ws1", false],
      ["ws2", true],
    ]);

    expect(text(await tool("switch_workspace", { workspaceId: "ws1" }))).toBe(
      "Switched to workspace ws1. The other workspaces stay connected; nothing was revoked.",
    );

    expect(text(await tool("fleet_overview"))).toMatch(
      /^Workspace ws1: Nodes: 2 total/,
    );

    const disconnected = text(
      await tool("disconnect_workspace", { workspaceId: "ws1" }),
    );

    expect(disconnected).toContain("its cached key is deleted");
    expect(disconnected).toContain(
      "revoke it yourself on the workspace's Keys page: https://cloud.expanso.io/",
    );
    expect(disconnected).toContain("The active workspace is now ws2.");

    expect(
      text(await tool("disconnect_workspace", { workspaceId: "ws2" })),
    ).toContain("No workspace is connected now");

    const empty = ConnectionResultSchema.parse(
      JSON.parse(await tool("fleet_overview")),
    ).result.structuredContent.connection;

    expect(empty.status).toBe("not_connected");
    expect(empty.reconnectUrl).toContain(`${BASE}/workspaces/add?token=`);
  });

  it("refuses a key from another Expanso user on an add-workspace link", async () => {
    const tool = await signIn();

    const { url } = LinkResultSchema.parse(
      JSON.parse(await tool("add_workspace")),
    ).result.structuredContent;

    vi.stubGlobal(
      "fetch",
      fakeFetch(cloudRoutes("claims-other-user.json")).fetch,
    );

    const refused = await submitLink(url, {
      api_key: API_KEY,
      endpoint: ENDPOINT,
    });

    expect(refused.status).toBe(400);

    const html = await refused.text();

    expect(html).toContain("belongs to a different Expanso user");
    expect(html).not.toContain(API_KEY);
  });

  it("asks to reconnect when Expanso Cloud stops accepting the key", async () => {
    const tool = await signIn();

    const cloud = fakeFetch({
      ...cloudRoutes(),
      [`POST ${CLOUD}/api/v1/auth/token`]: fail(
        401,
        "Invalid or expired API key",
      ),
    });

    vi.stubGlobal("fetch", cloud.fetch);

    const first = ConnectionResultSchema.parse(
      JSON.parse(await tool("fleet.open")),
    ).result.structuredContent.connection;

    expect(first).toMatchObject({ status: "reconnect", workspaceId: "ws1" });
    expect(first.reconnectUrl).toContain(`${BASE}/workspaces/add?token=`);

    const exchanges = cloud.requests.length;

    // The workspace stays marked, so Cloud is not asked again.
    const second = ConnectionResultSchema.parse(
      JSON.parse(await tool("list_jobs")),
    ).result.structuredContent.connection;

    expect(second.status).toBe("reconnect");
    expect(cloud.requests).toHaveLength(exchanges);

    expect(
      WorkspacesSchema.parse(JSON.parse(await tool("list_workspaces"))).result
        .structuredContent.workspaces,
    ).toEqual([{ workspaceId: "ws1", active: true, needsReconnect: true }]);
  });

  it("finds no mentions and mints no links until a workspace can be read", async () => {
    const tool = await signIn();

    vi.stubGlobal(
      "fetch",
      fakeFetch({
        ...cloudRoutes(),
        [`POST ${CLOUD}/api/v1/auth/token`]: fail(
          401,
          "Invalid or expired API key",
        ),
      }).fetch,
    );

    await tool("fleet.open");

    const mentions = async () =>
      MentionsSchema.parse(
        JSON.parse(await tool("search_mentions", { query: "ingest" })),
      ).result.structuredContent.items;

    const links = await addLinkCount();

    expect(await mentions()).toEqual([]);
    expect(await mentions()).toEqual([]);
    expect(await addLinkCount()).toBe(links);

    await tool("disconnect_workspace", { workspaceId: "ws1" });

    expect(await mentions()).toEqual([]);
    expect(await addLinkCount()).toBe(links);
  });

  it("gives the Reconnect link when a mentioned item cannot be read", async () => {
    const tool = await signIn();

    vi.stubGlobal(
      "fetch",
      fakeFetch({
        ...cloudRoutes(),
        [`POST ${CLOUD}/api/v1/auth/token`]: fail(
          401,
          "Invalid or expired API key",
        ),
      }).fetch,
    );

    const { message } = RpcErrorSchema.parse(
      JSON.parse(
        await tool.rpc("resources/read", {
          uri: "expanso://workspaces/ws1/jobs/job-ingest-7f3a",
        }),
      ),
    ).error;

    expect(message).toContain(
      `Reconnect it here: ${BASE}/workspaces/add?token=`,
    );
  });

  it("offers previews and changes only to connections granted fleet", async () => {
    const { identity } = await linkAccount(API_KEY, ENDPOINT, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch: fakeFetch(cloudRoutes()).fetch,
    });

    const account = new Account(identity, {
      kv: env.OAUTH_KV,
      encryptionKey: TEST_ENCRYPTION_KEY,
      cloudUrl: CLOUD,
      publicBaseUrl: BASE,
      consoleUrl: "https://console.test",
    });

    const toolNames = async (scopes: string[]) => {
      const server = buildServer({
        account,
        connections: [],
        scopes,
        appHtml: "<html></html>",
        iconSvg: "<svg></svg>",
      });

      const client = new Client({ name: "test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

      await server.connect(serverSide);
      await client.connect(clientSide);

      const { tools } = await client.listTools();

      await client.close();

      return tools.map((tool) => tool.name);
    };

    const changes = [
      "preview_change",
      "deploy_job",
      "stop_job",
      "rerun_job",
      "delete_job",
      "rollback_job",
      "pause_rollout",
      "resume_rollout",
      "delete_node",
    ];

    const granted = await toolNames(["fleet", "logs"]);

    expect(granted).toEqual(expect.arrayContaining(changes));

    // A grant from the read-only plugin carries fleet:read, never fleet.
    const readOnlyGrant = await toolNames(["fleet:read"]);

    for (const name of changes) expect(readOnlyGrant).not.toContain(name);

    expect(readOnlyGrant).toEqual(
      expect.arrayContaining(["list_jobs", "get_job_spec", "fleet_dashboard"]),
    );
  });

  it("keeps log access for a read-only plugin grant of logs:read", async () => {
    const { identity } = await linkAccount(API_KEY, ENDPOINT, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch: fakeFetch(cloudRoutes()).fetch,
    });

    const account = new Account(identity, {
      kv: env.OAUTH_KV,
      encryptionKey: TEST_ENCRYPTION_KEY,
      cloudUrl: CLOUD,
      publicBaseUrl: BASE,
      consoleUrl: "https://console.test",
      fetch: fakeFetch(cloudRoutes()).fetch,
    });

    const readLogs = async (scopes: string[]) => {
      const server = buildServer({
        account,
        connections: await account.connections(),
        scopes,
        appHtml: "<html></html>",
        iconSvg: "<svg></svg>",
      });

      const client = new Client({ name: "test", version: "0" });
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

      await server.connect(serverSide);
      await client.connect(clientSide);

      const result = JSON.stringify(
        await client.callTool({
          name: "get_job_logs",
          arguments: { jobId: "job-ingest-7f3a" },
        }),
      );

      await client.close();

      return result;
    };

    const denied = "This connection was not granted log access";

    expect(await readLogs(["fleet:read", "logs:read"])).not.toContain(denied);
    expect(await readLogs(["fleet", "logs"])).not.toContain(denied);
    expect(await readLogs(["fleet:read"])).toContain(denied);
  });
});
