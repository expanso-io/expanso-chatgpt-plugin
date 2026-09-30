import type { z } from "zod";
import { assertSafeId } from "../config.js";
import {
  ErrorBodySchema,
  ExecutionEnvelopeSchema,
  ExecutionPageSchema,
  HistoryPageSchema,
  JobEnvelopeSchema,
  JobPageSchema,
  NodeEnvelopeSchema,
  NodePageSchema,
  NodeStatsSchema,
  TokenClaimsSchema,
  TokenResponseSchema,
  type Execution,
  type ExecutionState,
  type HistoryEvent,
  type Job,
  type Node,
  type NodeStats,
  type Page,
} from "./types.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 15_000;

const API_KEY_PREFIX = "exp_ak_";

const DEFAULT_TOKEN_SECONDS = 3600;

/**
 * Expanso Cloud's edge firewall rejects requests without a User-Agent, and
 * Worker fetch sends none by default, so every outbound call names itself.
 */
export const USER_AGENT = "expanso-fleet-mcp/0.1.0";

export class CloudApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "CloudApiError";
  }
}

/** The service answered, but not in the shape this client reads. */
export class UnexpectedResponseError extends CloudApiError {
  constructor(message: string) {
    super(message, 502);
    this.name = "UnexpectedResponseError";
  }
}

export interface OrchestratorToken {
  accessToken: string;
  /** Epoch milliseconds after which the token must not be used. */
  expiresAt: number;
  claims: TokenClaims;
}

export interface TokenClaims {
  sub: string;
  email?: string;
  organizationId: string;
  /** Workspace the key is bound to, or "*" for every workspace in the org. */
  networkId: string;
}

/** Exchanges an Expanso API key for a short-lived orchestrator token. */
export async function exchangeApiKey(
  cloudUrl: string,
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<OrchestratorToken> {
  const key = apiKey.trim();

  if (!key.startsWith(API_KEY_PREFIX)) {
    throw new CloudApiError(
      `Expanso API keys start with ${API_KEY_PREFIX}.`,
      400,
    );
  }

  const response = await fetchImpl(`${cloudUrl}/api/v1/auth/token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw await toError(response, "Expanso Cloud rejected the API key");
  }

  const body = await parseBody(
    response,
    TokenResponseSchema,
    "Expanso Cloud returned no access token.",
  );

  const expiresIn = body.expires_in ?? DEFAULT_TOKEN_SECONDS;

  return {
    accessToken: body.access_token,
    expiresAt: Date.now() + expiresIn * 1000,
    claims: decodeClaims(body.access_token),
  };
}

/**
 * Reads the claims of a token Expanso Cloud just returned over TLS. The
 * signature is not checked here because the orchestrator verifies it on every
 * call; the claims only label the linked account.
 */
export function decodeClaims(token: string): TokenClaims {
  const payload = token.split(".")[1];

  if (!payload) {
    throw new CloudApiError("Expanso Cloud returned a malformed token.", 502);
  }

  let json: string;

  try {
    json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    throw new CloudApiError("Expanso Cloud returned a malformed token.", 502);
  }

  const claims = parseJson(json, TokenClaimsSchema);

  if (!claims.success) {
    throw new CloudApiError(
      "The API key is not bound to an Expanso organization.",
      403,
    );
  }

  return {
    sub: claims.data.sub,
    organizationId: claims.data.organizationId,
    email: claims.data.email,
    networkId: claims.data.networkId || "*",
  };
}

type Query = Record<string, string | number | string[] | undefined>;

export interface ListOptions {
  limit?: number;
  nextToken?: string;
}

/** Read-only client for one workspace's orchestrator API. */
export class WorkspaceClient {
  constructor(
    readonly endpoint: string,
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  nodeStats(): Promise<NodeStats> {
    return this.get("/nodes/stats", NodeStatsSchema);
  }

  listNodes(
    options: ListOptions & { prefix?: string; labels?: string } = {},
  ): Promise<Page<Node>> {
    return this.get("/nodes", NodePageSchema, {
      prefix: options.prefix,
      labels: options.labels,
      limit: options.limit,
      next_token: options.nextToken,
      order_by: "name",
      order: "asc",
    });
  }

  async getNode(id: string): Promise<Node> {
    const body = await this.get(
      `/nodes/${encodeURIComponent(assertSafeId(id, "Node ID"))}`,
      NodeEnvelopeSchema,
    );

    return body.node ?? {};
  }

  listJobs(
    options: ListOptions & { prefix?: string } = {},
  ): Promise<Page<Job>> {
    return this.get("/jobs", JobPageSchema, {
      prefix: options.prefix,
      limit: options.limit,
      next_token: options.nextToken,
      order_by: "updated_at",
      order: "desc",
    });
  }

  async getJob(id: string): Promise<Job> {
    const body = await this.get(
      `/jobs/${encodeURIComponent(assertSafeId(id, "Job ID"))}`,
      JobEnvelopeSchema,
    );

    return body.job ?? {};
  }

  jobHistory(
    id: string,
    options: ListOptions = {},
  ): Promise<Page<HistoryEvent>> {
    return this.get(
      `/jobs/${encodeURIComponent(assertSafeId(id, "Job ID"))}/history`,
      HistoryPageSchema,
      { limit: options.limit, next_token: options.nextToken },
    );
  }

  jobExecutions(
    id: string,
    options: ListOptions & { states?: ExecutionState[] } = {},
  ): Promise<Page<Execution>> {
    return this.get(
      `/jobs/${encodeURIComponent(assertSafeId(id, "Job ID"))}/executions`,
      ExecutionPageSchema,
      {
        states: options.states,
        limit: options.limit,
        next_token: options.nextToken,
        order_by: "updated_at",
        order: "desc",
      },
    );
  }

  listExecutions(
    options: ListOptions & {
      jobId?: string;
      nodeIds?: string[];
      states?: ExecutionState[];
    } = {},
  ): Promise<Page<Execution>> {
    return this.get("/executions", ExecutionPageSchema, {
      job_id: options.jobId && assertSafeId(options.jobId, "Job ID"),
      node_ids: options.nodeIds?.map((id) => assertSafeId(id, "Node ID")),
      states: options.states,
      limit: options.limit,
      next_token: options.nextToken,
      order_by: "updated_at",
      order: "desc",
    });
  }

  async getExecution(id: string): Promise<Execution> {
    const body = await this.get(
      `/executions/${encodeURIComponent(assertSafeId(id, "Execution ID"))}`,
      ExecutionEnvelopeSchema,
    );

    return body.execution ?? {};
  }

  executionHistory(
    id: string,
    options: ListOptions = {},
  ): Promise<Page<HistoryEvent>> {
    return this.get(
      `/executions/${encodeURIComponent(assertSafeId(id, "Execution ID"))}/history`,
      HistoryPageSchema,
      { limit: options.limit, next_token: options.nextToken },
    );
  }

  private async get<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    query: Query = {},
  ): Promise<z.output<Schema>> {
    const url = `https://${this.endpoint}/api/v1${path}${toQueryString(query)}`;

    // Workers' fetch throws "Illegal invocation" when called as a method.
    const fetchImpl = this.fetchImpl;

    const response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw await toError(response, "The Expanso workspace request failed");
    }

    return parseBody(
      response,
      schema,
      "The Expanso workspace returned an unexpected response.",
    );
  }
}

/** Matches the orchestrator's generated client: arrays repeat their key. */
export function toQueryString(query: Query): string {
  const parts: string[] = [];

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "") continue;

    const values = Array.isArray(value) ? value : [value];

    for (const item of values) {
      parts.push(
        `${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`,
      );
    }
  }

  return parts.length > 0 ? `?${parts.join("&")}` : "";
}

async function parseBody<Schema extends z.ZodType>(
  response: Response,
  schema: Schema,
  failure: string,
): Promise<z.output<Schema>> {
  const parsed = parseJson(await response.text(), schema);

  if (!parsed.success) throw new UnexpectedResponseError(failure);

  return parsed.data;
}

/**
 * Parses JSON text straight into a schema; malformed JSON fails the parse.
 * Null object fields are dropped first: Go services encode empty lists and
 * maps as null, and every field here is optional.
 */
export function parseJson<Schema extends z.ZodType>(
  raw: string,
  schema: Schema,
): z.ZodSafeParseResult<z.output<Schema>> {
  try {
    return schema.safeParse(
      JSON.parse(raw, (_key, value) => (value === null ? undefined : value)),
    );
  } catch {
    return schema.safeParse(undefined);
  }
}

async function toError(response: Response, fallback: string): Promise<Error> {
  const body = parseJson(await response.text(), ErrorBodySchema);
  const detail = body.success ? (body.data.message ?? "").slice(0, 300) : "";

  const reason =
    response.status === 401 || response.status === 403
      ? `access was denied (HTTP ${response.status})`
      : response.status === 404
        ? "not found"
        : `HTTP ${response.status}`;

  return new CloudApiError(
    detail ? `${fallback}: ${reason} (${detail})` : `${fallback}: ${reason}.`,
    response.status,
  );
}
