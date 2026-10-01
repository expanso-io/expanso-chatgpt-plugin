import {
  AuthorizationError,
  CimdFetchError,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { GrantProps } from "../account.js";
import {
  CloudApiError,
  UnexpectedResponseError,
  exchangeApiKey,
  WorkspaceClient,
  type FetchLike,
  type OrchestratorToken,
} from "../cloud/client.js";
import {
  LinkError,
  keyForOtherWorkspace,
  keyRejected,
  notAnApiKey,
  notAnEndpoint,
  workspaceRejected,
  type WorkspaceFailure,
} from "./link-errors.js";

export { LinkError };

import {
  apiKeysPageUrl,
  parseWorkspaceEndpoint,
  type ServiceConfig,
} from "../config.js";
import { ConnectionStore, type NewConnection } from "../connections.js";
import { errorPage, linkPage, PAGE_CSP, type LinkFormState } from "./page.js";

export interface LinkDeps {
  config: ServiceConfig;
  encryptionKey: string;
  fetch?: FetchLike;
}

export interface AuthorizeDeps extends LinkDeps {
  oauth: OAuthHelpers;
  kv: KVNamespace;
}

/** A checked key: who it belongs to, and the workspace it opens. */
export interface LinkedAccount {
  identity: GrantProps;
  connection: NewConnection;
}

/**
 * The OAuth front door's authorization endpoint. GET shows the linking page;
 * POST checks the pasted API key with Expanso Cloud, confirms the workspace
 * endpoint answers for that key, caches the key sealed in the account's
 * connection store as the active workspace, and completes authorization.
 * PKCE, client, and redirect URI checks happen in parseAuthRequest.
 */
export async function handleAuthorize(
  request: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  try {
    if (request.method === "GET") return await showPage(request, deps);

    if (request.method === "POST") return await submit(request, deps);

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }

    if (error instanceof AuthorizationError) {
      return errorPage(error.description);
    }

    if (error instanceof CimdFetchError) {
      return errorPage("This app could not be verified.");
    }

    throw error;
  }
}

async function showPage(
  request: Request,
  deps: AuthorizeDeps,
  state: LinkFormState = {},
): Promise<Response> {
  const authRequest = await deps.oauth.parseAuthRequest(request);
  const details = await deps.oauth.describeConsent(authRequest);
  const consent = await deps.oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Content-Security-Policy", PAGE_CSP);
  consent.headers.set("Referrer-Policy", "no-referrer");

  const page = linkPage(details, consent.handle, {
    ...state,
    apiKeysUrl: apiKeysPageUrl(deps.config.consoleUrl),
  });

  return new Response(page, {
    status: state.error ? 400 : 200,
    headers: consent.headers,
  });
}

async function submit(
  request: Request,
  deps: AuthorizeDeps,
): Promise<Response> {
  const form = await request.clone().formData();
  const handle = String(form.get("handle") ?? "");

  if (form.get("decision") !== "approve") {
    const denied = await deps.oauth.denyConsent(request, handle);

    return new Response(null, { status: 302, headers: denied.headers });
  }

  const endpointText = String(form.get("endpoint") ?? "");
  const apiKey = String(form.get("api_key") ?? "");

  let linked: LinkedAccount;

  try {
    linked = await linkAccount(apiKey, endpointText, deps);
  } catch (error) {
    if (error instanceof LinkError) {
      // Show the form again with a fresh consent handle. The key is never echoed.
      // The authorization parameters live in the query string, so re-parse them
      // from a GET of the same URL rather than from this form body.
      const retry = new Request(request.url, {
        method: "GET",
        headers: request.headers,
      });

      return showPage(retry, deps, {
        endpoint: endpointText,
        error: error.message,
        errorField: error.field,
      });
    }

    throw error;
  }

  await new ConnectionStore(linked.identity.accountId, {
    kv: deps.kv,
    encryptionKey: deps.encryptionKey,
  }).add(linked.connection);

  const approved = await deps.oauth.approveConsent(request, handle, {
    scope: form.getAll("scope").map(String),
  });

  const { redirectTo } = await deps.oauth.completeAuthorization({
    request: approved.request,
    userId: linked.identity.accountId,
    metadata: { organizationId: linked.identity.organizationId },
    scope: approved.request.scope,
    props: linked.identity,
  });

  approved.headers.set("Location", redirectTo);

  return new Response(null, { status: 302, headers: approved.headers });
}

/**
 * Checks a pasted key and workspace endpoint with Expanso Cloud and the
 * workspace itself. Returns the account the key belongs to and the connection
 * to cache; the key is sealed only when the store saves it.
 */
export async function linkAccount(
  apiKey: string,
  endpointText: string,
  deps: LinkDeps,
): Promise<LinkedAccount> {
  const raw = endpointText.trim();

  if (raw.length === 0) {
    throw new LinkError("Enter the workspace endpoint.", "endpoint");
  }

  let workspace: { workspaceId: string; endpoint: string };

  try {
    workspace = parseWorkspaceEndpoint(raw, deps.config.endpointSuffixes);
  } catch {
    throw notAnEndpoint(raw);
  }

  if (!apiKey.trim().startsWith("exp_ak_")) throw notAnApiKey();

  let token: OrchestratorToken;

  try {
    token = await exchangeApiKey(deps.config.cloudUrl, apiKey, deps.fetch);
  } catch (error) {
    throw keyRejected(
      error instanceof CloudApiError ? error.status : undefined,
    );
  }

  const { claims } = token;

  if (claims.networkId !== "*" && claims.networkId !== workspace.workspaceId) {
    throw keyForOtherWorkspace(claims.networkId, workspace.workspaceId);
  }

  // The orchestrator enforces the token's organization, so a successful read
  // proves the workspace belongs to the key's organization.
  try {
    await new WorkspaceClient(
      workspace.endpoint,
      token.accessToken,
      deps.fetch,
    ).nodeStats();
  } catch (error) {
    const failure: WorkspaceFailure =
      error instanceof UnexpectedResponseError
        ? { kind: "unexpected" }
        : error instanceof CloudApiError
          ? { kind: "http", status: error.status }
          : { kind: "unreachable" };

    // Operators see which step failed; the key and token are never logged.
    console.warn(
      JSON.stringify({
        event: "link_failed",
        step: "workspace_read",
        workspaceId: workspace.workspaceId,
        ...failure,
      }),
    );

    throw workspaceRejected(workspace.workspaceId, failure);
  }

  const identity: GrantProps = {
    accountId: await opaqueAccountId(claims.organizationId, claims.sub),
    organizationId: claims.organizationId,
  };

  if (claims.email !== undefined) identity.email = claims.email;

  return {
    identity,
    connection: { ...workspace, apiKey: apiKey.trim() },
  };
}

/** Opaque and stable per Expanso user and organization; reveals neither. */
export async function opaqueAccountId(
  organizationId: string,
  userId: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`expanso-fleet\n${organizationId}\n${userId}`),
  );

  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
