import { z } from "zod";
import {
  CloudApiError,
  USER_AGENT,
  parseJson,
  type FetchLike,
} from "./client.js";

// Every workspace a user can reach, and a status summary for each, from
// Expanso Cloud's workspace directory (expanso-io/expanso-cloud#1967:
// GET /api/v1/workspaces and GET /api/v1/workspaces/status). Until Cloud
// serves those routes they answer 404, the directory reports itself
// unavailable, and the Fleets view shows the workspaces this connection has
// keys for, with status read from the active workspace's own orchestrator.

const REQUEST_TIMEOUT_MS = 15_000;

const text = z.string().optional();

const count = z.number().int().nonnegative().optional();

export const DirectoryWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: text,
  slug: text,
  organization_id: text,
  organization_name: text,
  organization_slug: text,
  /** host[:port] of the workspace orchestrator. */
  endpoint: text,
  /** Cloud's lifecycle state, for example "ready" or "provisioning". */
  state: text,
});

export const FleetStatusSchema = z.object({
  workspace_id: z.string().min(1),
  nodes: z
    .object({ total: count, healthy: count, unhealthy: count })
    .optional(),
  jobs: z.object({ total: count, running: count, failing: count }).optional(),
  last_activity_at: text,
});

// Cloud list endpoints name the array after the resource; accept "items" too.
const WorkspaceListSchema = z
  .object({
    workspaces: z.array(DirectoryWorkspaceSchema).optional(),
    items: z.array(DirectoryWorkspaceSchema).optional(),
  })
  .transform((body) => body.workspaces ?? body.items ?? []);

const StatusListSchema = z
  .object({
    workspaces: z.array(FleetStatusSchema).optional(),
    items: z.array(FleetStatusSchema).optional(),
  })
  .transform((body) => body.workspaces ?? body.items ?? []);

export type DirectoryWorkspace = z.infer<typeof DirectoryWorkspaceSchema>;

export type FleetStatus = z.infer<typeof FleetStatusSchema>;

export interface FleetDirectory {
  /** Every workspace the signed-in user can reach, or undefined when Cloud has no directory yet. */
  workspaces(): Promise<DirectoryWorkspace[] | undefined>;
  /** Status for every reachable workspace, or undefined when Cloud has no status route yet. */
  statuses(): Promise<FleetStatus[] | undefined>;
}

/** Reads the directory from Expanso Cloud with the connection's own token. */
export class CloudFleetDirectory implements FleetDirectory {
  constructor(
    private readonly cloudUrl: string,
    private readonly accessToken: () => Promise<string>,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  workspaces(): Promise<DirectoryWorkspace[] | undefined> {
    return this.get("/api/v1/workspaces", WorkspaceListSchema);
  }

  statuses(): Promise<FleetStatus[] | undefined> {
    return this.get("/api/v1/workspaces/status", StatusListSchema);
  }

  private async get<Schema extends z.ZodType>(
    path: string,
    schema: Schema,
  ): Promise<z.output<Schema> | undefined> {
    const fetchImpl = this.fetchImpl;

    const response = await fetchImpl(`${this.cloudUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${await this.accessToken()}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Not deployed yet: the caller falls back to connected workspaces.
    if (response.status === 404 || response.status === 405) return undefined;

    if (!response.ok) {
      throw new CloudApiError(
        `Expanso Cloud could not list workspaces (HTTP ${response.status}).`,
        response.status,
      );
    }

    const parsed = parseJson(await response.text(), schema);

    // A shape this client does not know yet is treated like a missing route.
    return parsed.success ? parsed.data : undefined;
  }
}
