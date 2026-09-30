import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Account, GrantPropsSchema } from "./account.js";
import { SCOPES, serviceConfig, type Env } from "./config.js";
import { handleAuthorize } from "./oauth/authorize.js";
import { buildServer } from "./mcp/server.js";
import { FLEET_APP_HTML, ICON_SVG } from "./generated/assets.js";

/** What the OAuth provider verified about the access token on this request. */
interface VerifiedToken {
  scope?: string[];
  clientId?: string;
  expiresAt?: number;
}

type ProviderContext = ExecutionContext & { auth?: VerifiedToken };

const mcpHandler = {
  async fetch(
    request: Request,
    env: Env,
    ctx: ProviderContext,
  ): Promise<Response> {
    const props = GrantPropsSchema.safeParse(ctx.props);

    if (!props.success) {
      return new Response("This connection needs to be linked again.", {
        status: 401,
      });
    }

    const config = serviceConfig(env, request.url);

    const account = new Account(props.data, {
      kv: env.OAUTH_KV,
      encryptionKey: env.LINK_ENCRYPTION_KEY,
      cloudUrl: config.cloudUrl,
    });

    const scopes = ctx.auth?.scope ?? [];

    const server = buildServer({
      account,
      scopes,
      appHtml: FLEET_APP_HTML,
      iconSvg: ICON_SVG,
    });

    // Stateless: each POST carries a complete JSON-RPC exchange.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);

    return transport.handleRequest(request, {
      authInfo: {
        token: "",
        clientId: ctx.auth?.clientId ?? "",
        scopes,
        expiresAt: ctx.auth?.expiresAt,
        extra: { accountId: props.data.accountId },
      },
    });
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const config = serviceConfig(env, request.url);

    if (url.pathname === "/authorize") {
      if (!env.OAUTH_PROVIDER) {
        return new Response("Authorization is unavailable.", { status: 500 });
      }

      return handleAuthorize(request, {
        oauth: env.OAUTH_PROVIDER,
        config,
        encryptionKey: env.LINK_ENCRYPTION_KEY,
      });
    }

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({ service: "expanso-fleet-mcp", ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
};

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env, requestUrl: string): OAuthProvider<Env> {
  if (provider) return provider;

  const { publicBaseUrl } = serviceConfig(env, requestUrl);

  provider = new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpHandler,
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/oauth/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [SCOPES.fleetRead, SCOPES.logsRead],
    requiredScopes: [SCOPES.fleetRead],
    resourceMetadata: {
      resource: `${publicBaseUrl}/mcp`,
      authorization_servers: [publicBaseUrl],
      resource_name: "Expanso Fleet",
    },
    accessTokenTTL: 3600,
  });

  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!env.LINK_ENCRYPTION_KEY) {
      return Promise.resolve(
        new Response("Service is not configured.", { status: 503 }),
      );
    }

    return getProvider(env, request.url).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
