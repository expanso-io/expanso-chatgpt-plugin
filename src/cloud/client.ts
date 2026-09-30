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
  NodeDeleteResponseSchema,
  NodeStatsSchema,
  JobDiffResponseSchema,
  JobIdResponseSchema,
  JobVersionDiffSchema,
  JobSpecEnvelopeSchema,
  JobVersionPageSchema,
  JobVersionSpecsSchema,
  PutJobResponseSchema,
  QueryRangeSchema,
  RawJobEnvelopeSchema,
  RerunResponseSchema,
  RollbackResponseSchema,
  ServiceStatusSchema,
  TokenClaimsSchema,
  TokenResponseSchema,
  type Execution,
  type ExecutionState,
  type HistoryEvent,
  type Job,
  type JobSpec,
  type JsonFields,
  type JobVersion,
  type Node,
  type NodeMetric,
  type NodeStats,
  type Page,
  type QueryRange,
  type ServiceStatus,
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

/** Client for one workspace's orchestrator API. */
export class WorkspaceClient {
  constructor(
    readonly endpoint: string,
    private readonly accessToken: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  status(): Promise<ServiceStatus> {
    return this.get("/status", ServiceStatusSchema);
  }

  nodeStats(): Promise<NodeStats> {
    // The orchestrator serves stats at /nodes/-/stats; /nodes/stats is read as
    // a node named "stats" and answers 404, whatever the API reference says.
    return this.get("/nodes/-/stats", NodeStatsSchema);
  }

  listNodes(
    options: ListOptions & { prefix?: string; labels?: string[] } = {},
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
    const body = await this.get(nodePath(id), NodeEnvelopeSchema);

    return body.node ?? {};
  }

  /** Soft-deletes a node. Connected nodes need force. */
  deleteNode(
    id: string,
    body: { force?: boolean; reason?: string },
  ): Promise<z.output<typeof NodeDeleteResponseSchema>> {
    return this.send("DELETE", nodePath(id), NodeDeleteResponseSchema, body);
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
    const body = await this.get(jobPath(id), JobEnvelopeSchema);

    return body.job ?? {};
  }

  /**
   * The job with its complete spec, parsed without dropping nulls, so an
   * edit sends back every field it did not change.
   */
  async getJobSpec(
    id: string,
  ): Promise<{ id: string; spec: JobSpec; version?: number }> {
    const text = await this.fetchText("GET", jobPath(id), {});
    const body = decode(text, RawJobEnvelopeSchema);
    const spec = decode(text, JobSpecEnvelopeSchema, false).job?.spec;

    if (!spec) {
      throw new UnexpectedResponseError(
        "The Expanso workspace returned a job without a spec.",
      );
    }

    return {
      id: body.job?.id ?? id,
      spec,
      version: body.job?.status?.version,
    };
  }

  /**
   * Creates the job, or updates the job with the same name. With dryRun the
   * orchestrator validates everything, then rolls back instead of saving.
   */
  putJob(
    spec: JobSpec,
    options: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<PutJobResult> {
    return this.send("PUT", "/jobs", PutJobResponseSchema, {
      spec,
      force: options.force || undefined,
      dry_run: options.dryRun || undefined,
    });
  }

  /** Updates an existing job by ID; the spec may rename it. */
  putJobById(
    id: string,
    spec: JobSpec,
    options: { dryRun?: boolean; force?: boolean } = {},
  ): Promise<PutJobResult> {
    return this.send("PUT", jobPath(id), PutJobResponseSchema, {
      spec,
      force: options.force || undefined,
      dry_run: options.dryRun || undefined,
    });
  }

  /** The orchestrator's own diff of a spec against the job of the same name. */
  diffJob(spec: JobSpec): Promise<{ diff: string; warnings: string[] }> {
    return this.send("PUT", "/jobs/-/diff", JobDiffResponseSchema, { spec });
  }

  stopJob(id: string, reason?: string): Promise<{ job_id?: string }> {
    return this.send("POST", `${jobPath(id)}/stop`, JobIdResponseSchema, {
      reason,
    });
  }

  /** Soft-deletes a job. Without force it must be stopped, completed, or failed. */
  deleteJob(
    id: string,
    body: { force?: boolean; reason?: string },
  ): Promise<{ job_id?: string }> {
    return this.send("DELETE", jobPath(id), JobIdResponseSchema, body);
  }

  /** Restarts every execution with the current spec, as a new rollout. */
  rerunJob(id: string): Promise<z.output<typeof RerunResponseSchema>> {
    return this.send("PUT", `${jobPath(id)}/rerun`, RerunResponseSchema, {});
  }

  rollbackJob(
    id: string,
    body: { version?: number; reason?: string; dryRun?: boolean },
  ): Promise<z.output<typeof RollbackResponseSchema>> {
    return this.send(
      "POST",
      `${jobPath(id)}/rollback`,
      RollbackResponseSchema,
      {
        version: body.version,
        reason: body.reason,
        dry_run: body.dryRun || undefined,
      },
    );
  }

  pauseRollout(id: string, reason?: string): Promise<{ job_id?: string }> {
    return this.send(
      "POST",
      `${jobPath(id)}/rollout/pause`,
      JobIdResponseSchema,
      { reason },
    );
  }

  resumeRollout(id: string, reason?: string): Promise<{ job_id?: string }> {
    return this.send(
      "POST",
      `${jobPath(id)}/rollout/resume`,
      JobIdResponseSchema,
      { reason },
    );
  }

  /** Versions with their specs, read without dropping nulls. */
  async jobVersions(id: string): Promise<Page<JobVersion>> {
    const text = await this.fetchText("GET", `${jobPath(id)}/versions`, {});
    const page = decode(text, JobVersionPageSchema);
    const specs = decode(text, JobVersionSpecsSchema, false).items ?? [];

    return {
      next_token: page.next_token,
      items: (page.items ?? []).map((item, index) => ({
        ...item,
        spec: specs[index]?.spec ?? undefined,
      })),
    };
  }

  jobVersionDiff(
    id: string,
    from: number,
    to?: number,
  ): Promise<z.output<typeof JobVersionDiffSchema>> {
    return this.get(`${jobPath(id)}/versions/diff`, JobVersionDiffSchema, {
      from,
      to,
    });
  }

  jobHistory(
    id: string,
    options: ListOptions & { since?: string } = {},
  ): Promise<Page<HistoryEvent>> {
    return this.get(`${jobPath(id)}/history`, HistoryPageSchema, {
      since: options.since,
      limit: options.limit,
      next_token: options.nextToken,
    });
  }

  jobExecutions(
    id: string,
    options: ListOptions & { states?: ExecutionState[] } = {},
  ): Promise<Page<Execution>> {
    return this.get(`${jobPath(id)}/executions`, ExecutionPageSchema, {
      states: options.states,
      limit: options.limit,
      next_token: options.nextToken,
      order_by: "updated_at",
      order: "desc",
    });
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

  /**
   * Per-node resource samples from node heartbeats. The orchestrator keeps
   * them in memory for about 30 minutes.
   */
  queryRange(
    metric: NodeMetric,
    options: { start: number; end: number; step: number },
  ): Promise<QueryRange> {
    return this.get("/metrics/query_range", QueryRangeSchema, {
      query: metric,
      start: Math.floor(options.start),
      end: Math.floor(options.end),
      step: Math.max(1, Math.floor(options.step)),
    });
  }

  private get<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
    query: Query = {},
  ): Promise<z.output<Schema>> {
    return this.request("GET", path, schema, { query });
  }

  private send<Schema extends z.ZodType>(
    method: "PUT" | "POST" | "DELETE",
    path: string,
    schema: Schema,
    body: JsonFields,
  ): Promise<z.output<Schema>> {
    return this.request(method, path, schema, { body });
  }

  private async request<Schema extends z.ZodType>(
    method: string,
    path: string,
    schema: Schema,
    options: { query?: Query; body?: JsonFields },
  ): Promise<z.output<Schema>> {
    return decode(await this.fetchText(method, path, options), schema);
  }

  private async fetchText(
    method: string,
    path: string,
    options: { query?: Query; body?: JsonFields },
  ): Promise<string> {
    const url = `https://${this.endpoint}/api/v1${path}${toQueryString(options.query ?? {})}`;

    // Workers' fetch throws "Illegal invocation" when called as a method.
    const fetchImpl = this.fetchImpl;

    const headers = new Headers({
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    });

    if (options.body) headers.set("Content-Type", "application/json");

    const response = await fetchImpl(url, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw await toError(response, "The Expanso workspace request failed");
    }

    return response.text();
  }
}

function decode<Schema extends z.ZodType>(
  text: string,
  schema: Schema,
  dropNulls = true,
): z.output<Schema> {
  const parsed = parseJson(text, schema, dropNulls);

  if (!parsed.success) {
    throw new UnexpectedResponseError(
      "The Expanso workspace returned an unexpected response.",
    );
  }

  return parsed.data;
}

export type PutJobResult = z.output<typeof PutJobResponseSchema>;

function jobPath(id: string): string {
  return `/jobs/${encodeURIComponent(assertSafeId(id, "Job ID"))}`;
}

function nodePath(id: string): string {
  return `/nodes/${encodeURIComponent(assertSafeId(id, "Node ID"))}`;
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
  dropNulls = true,
): z.ZodSafeParseResult<z.output<Schema>> {
  try {
    return schema.safeParse(
      dropNulls
        ? JSON.parse(raw, (_key, value) => (value === null ? undefined : value))
        : JSON.parse(raw),
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
