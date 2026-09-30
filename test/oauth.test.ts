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
import type { JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Env } from "../src/config.js";
import { open } from "../src/crypto.js";
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
};

function cloudRoutes(claims = "claims-org-wide.json") {
  return {
    [`POST ${CLOUD}/api/v1/auth/token`]: serveToken(claims),
    [`GET ${API}/nodes/stats`]: serve("node-stats.json"),
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
  it("checks the key with Cloud, probes the workspace, and seals the key", async () => {
    const { fetch, requests } = fakeFetch(cloudRoutes());

    const { props } = await linkAccount(API_KEY, `https://${ENDPOINT}\n`, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch,
    });

    expect(requests.map((r) => `${r.method} ${r.url.pathname}`)).toEqual([
      "POST /api/v1/auth/token",
      "GET /api/v1/nodes/stats",
    ]);

    expect(props.workspaces).toEqual([
      { workspaceId: "ws1", endpoint: ENDPOINT },
    ]);

    expect(props.organizationId).toBe("org_fixture");

    expect(props.accountId).toBe(
      await opaqueAccountId("org_fixture", "usr_fixture_1"),
    );

    expect(JSON.stringify(props)).not.toContain(API_KEY);

    expect(
      await open(props.sealedApiKey, TEST_ENCRYPTION_KEY, props.accountId),
    ).toBe(API_KEY);
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
      [`GET ${API}/nodes/stats`]: fail(403, "forbidden"),
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

    expect(error?.field).toBe("endpoints");
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
      [`GET ${API}/nodes/stats`]: fail(404, "no route"),
    }).result;

    expect(error?.field).toBe("endpoints");
    expect(error?.message).toMatch(
      /could not be read at that endpoint \(it answered HTTP 404\)/,
    );
  });

  it("says when the workspace answers in a shape it cannot read", async () => {
    const error = await link(API_KEY, ENDPOINT, {
      ...cloudRoutes(),
      [`GET ${API}/nodes/stats`]: () => Response.json({ total_nodes: "many" }),
    }).result;

    expect(error?.field).toBe("endpoints");
    expect(error?.message).toMatch(/answered, but not in a form/);
  });

  it("says when the workspace gives no answer", async () => {
    const cloud = fakeFetch(cloudRoutes());

    const error = await linkAccount(API_KEY, ENDPOINT, {
      config,
      encryptionKey: TEST_ENCRYPTION_KEY,
      fetch: (input, init) =>
        input.includes("/api/v1/nodes/stats")
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
    scope: ["fleet:read"],
  };

  it("offers a Get my key button that opens Expanso Cloud in a new tab", () => {
    const html = linkPage(details, "h", {
      apiKeysUrl: "https://cloud.expanso.io/",
    });

    expect(html).toMatch(
      /<a class="button" href="https:\/\/cloud\.expanso\.io\/" target="_blank" rel="noopener noreferrer">Get my key from Expanso Cloud<\/a>/,
    );

    expect(html).toContain("No expiry");
    expect(html).toContain("full access to their workspace");
  });

  it("leaves the button out when no key page is configured", () => {
    expect(linkPage(details, "h")).not.toContain("Get my key");
  });

  it("marks the field an error is about", () => {
    const html = linkPage(details, "h", {
      error: "bad endpoint",
      errorField: "endpoints",
    });

    expect(html).toMatch(/id="endpoints"[^>]*aria-invalid="true"/);
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
        scope: ["fleet:read", '"><b>'],
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
          .object({ readOnlyHint: z.boolean() })
          .partial()
          .optional(),
      }),
    ),
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
      scope: "fleet:read logs:read",
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

    body.append("scope", "fleet:read");
    body.append("scope", "logs:read");

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
      endpoints: ENDPOINT,
    });

    expect(response.status).toBe(400);

    const html = await response.text();

    expect(html).toContain("Expanso Cloud does not recognize this API key");
    expect(html).toMatch(/id="api_key"[^>]*aria-invalid="true"/);
    expect(html).not.toContain(API_KEY);
  });

  it("links the key, issues a token for the PKCE verifier only, and serves read-only tools", async () => {
    const clientId = await register();
    const { verifier, challenge } = await pkce();

    const approved = await authorize(clientId, challenge, {
      decision: "approve",
      api_key: API_KEY,
      endpoints: ENDPOINT,
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

    expect(tokens.scope.split(" ").sort()).toEqual(["fleet:read", "logs:read"]);

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
        "fleet.inventory",
        "fleet.open",
        "fleet.summary",
        "fleet_overview",
        "get_execution",
        "get_job",
        "get_job_logs",
        "get_node",
        "get_profile",
        "list_executions",
        "list_jobs",
        "list_nodes",
        "recent_errors",
        "search_mentions",
        "settings.read",
        "settings.update",
      ].sort(),
    );

    // Nothing touches Expanso except to read it. settings.update only saves
    // this plugin's own default-workspace preference.
    for (const tool of tools) {
      if (tool.name === "settings.update") continue;

      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
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
  });
});
