import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Injected by the OAuth provider into handlers it calls. */
  OAUTH_PROVIDER?: OAuthHelpers;
  /** Base64 encoded 32 byte AES-GCM key that encrypts linked Expanso API keys. */
  LINK_ENCRYPTION_KEY: string;
  /** Canonical public origin of this service, for example https://fleet.example.workers.dev. */
  PUBLIC_BASE_URL?: string;
  /** Expanso Cloud origin that exchanges API keys for orchestrator tokens. */
  EXPANSO_CLOUD_URL?: string;
  /** Expanso Cloud console origin linked from the sign-in page. */
  EXPANSO_CONSOLE_URL?: string;
  /** Comma separated host suffixes a workspace endpoint may use. */
  ALLOWED_ENDPOINT_SUFFIXES?: string;
  /**
   * Set once Expanso Cloud serves the ChatGPT connect API
   * (expanso-io/expanso-cloud#1967). Unset, people paste a key instead.
   */
  EXPANSO_CONNECT_API?: string;
}

export const DEFAULT_CLOUD_URL = "https://cloud.expanso.io";

export const DEFAULT_ENDPOINT_SUFFIXES = [".expanso.io"];

/** Where people sign in to Expanso Cloud to create API keys. */
export const DEFAULT_CONSOLE_URL = "https://cloud.expanso.io";

export const SCOPES = {
  fleet: "fleet",
  logs: "logs",
} as const;

export interface ServiceConfig {
  publicBaseUrl: string;
  cloudUrl: string;
  consoleUrl: string;
  endpointSuffixes: string[];
  /** True when the Cloud connect API is switched on; see EXPANSO_CONNECT_API. */
  connectApi: boolean;
}

export function serviceConfig(env: Env, requestUrl: string): ServiceConfig {
  const publicBaseUrl = trimTrailingSlash(
    env.PUBLIC_BASE_URL ?? new URL(requestUrl).origin,
  );

  const cloudUrl = trimTrailingSlash(
    env.EXPANSO_CLOUD_URL ?? DEFAULT_CLOUD_URL,
  );

  if (!cloudUrl.startsWith("https://")) {
    throw new Error("EXPANSO_CLOUD_URL must use https.");
  }

  const endpointSuffixes = env.ALLOWED_ENDPOINT_SUFFIXES
    ? env.ALLOWED_ENDPOINT_SUFFIXES.split(",")
        .map((suffix) => suffix.trim().toLowerCase())
        .filter((suffix) => suffix.length > 0)
    : DEFAULT_ENDPOINT_SUFFIXES;

  const consoleUrl = trimTrailingSlash(
    env.EXPANSO_CONSOLE_URL ?? DEFAULT_CONSOLE_URL,
  );

  return {
    publicBaseUrl,
    cloudUrl,
    consoleUrl,
    endpointSuffixes,
    connectApi: Boolean(env.EXPANSO_CONNECT_API),
  };
}

/** A workspace as Expanso Cloud addresses it in console URLs. */
export interface ConsoleWorkspace {
  orgSlug: string;
  workspaceSlug: string;
}

/**
 * The page where API keys are created. Keys belong to a workspace, and Cloud
 * has no deep link that works without the organization and workspace slugs,
 * which differ from the workspace ID in the endpoint. Until Cloud can list a
 * key holder's workspaces (expanso-io/expanso-cloud#1965), callers pass no
 * workspace and people are told to open their workspace, then Keys.
 */
export function apiKeysPageUrl(
  consoleUrl: string,
  workspace?: ConsoleWorkspace,
): string {
  if (!workspace) return `${consoleUrl}/`;

  return `${consoleUrl}/${encodeURIComponent(workspace.orgSlug)}/workspaces/${encodeURIComponent(workspace.workspaceSlug)}/keys`;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export interface WorkspaceEndpoint {
  /** The workspace ID, which is the first DNS label of the orchestrator host. */
  workspaceId: string;
  /** host[:port] exactly as the orchestrator API is reached. */
  endpoint: string;
}

/**
 * Parses a workspace endpoint as shown in Expanso Cloud (host[:port], optionally
 * with an https:// prefix) and rejects anything outside the allowed host
 * suffixes. This is the SSRF boundary: the service only ever calls hosts that
 * pass this check.
 */
export function parseWorkspaceEndpoint(
  raw: string,
  allowedSuffixes: readonly string[],
): WorkspaceEndpoint {
  const trimmed = raw
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "");

  const match = /^([^:/?#@\s]+)(?::(\d{1,5}))?$/.exec(trimmed);

  if (!match) {
    throw new Error("Enter the endpoint as host or host:port.");
  }

  const host = match[1].toLowerCase();
  const port = match[2];

  if (port !== undefined) {
    const portNumber = Number(port);

    if (portNumber < 1 || portNumber > 65535) {
      throw new Error("The endpoint port is out of range.");
    }
  }

  const labels = host.split(".");

  if (labels.length < 3 || !labels.every((label) => HOST_LABEL.test(label))) {
    throw new Error("The endpoint host is not a valid workspace host.");
  }

  const allowed = allowedSuffixes.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );

  if (!allowed) {
    throw new Error("The endpoint is not an Expanso workspace host.");
  }

  return {
    workspaceId: labels[0],
    endpoint: port === undefined ? host : `${host}:${port}`,
  };
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** Validates IDs and names before they reach a URL path or a log query. */
export function assertSafeId(value: string, label: string): string {
  if (!SAFE_ID.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }

  return value;
}
