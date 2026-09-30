import { z } from "zod";
import { open } from "./crypto.js";
import {
  exchangeApiKey,
  WorkspaceClient,
  type FetchLike,
  type OrchestratorToken,
} from "./cloud/client.js";

const LinkedWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  endpoint: z.string().min(1),
  name: z.string().optional(),
});

/**
 * Data stored with the OAuth grant. The library encrypts it at rest and hands
 * it back on each request, where it is parsed again before use.
 */
export const GrantPropsSchema = z.object({
  /** Stable, opaque account ID: one per Expanso user and organization. */
  accountId: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.string().optional(),
  /** The Expanso API key, sealed again with the service's own key. */
  sealedApiKey: z.object({
    v: z.literal(1),
    iv: z.string(),
    data: z.string(),
  }),
  workspaces: z.array(LinkedWorkspaceSchema).min(1),
});

export type GrantProps = z.infer<typeof GrantPropsSchema>;

export type LinkedWorkspace = z.infer<typeof LinkedWorkspaceSchema>;

export interface Settings {
  defaultWorkspaceId: string;
}

// Orchestrator tokens live only in isolate memory and expire within an hour.
const tokenCache = new Map<string, OrchestratorToken>();

const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface AccountDeps {
  kv: KVNamespace;
  encryptionKey: string;
  cloudUrl: string;
  fetch?: FetchLike;
}

/** Everything a tool call needs about the signed-in account. */
export class Account {
  constructor(
    readonly props: GrantProps,
    private readonly deps: AccountDeps,
  ) {}

  get workspaces(): LinkedWorkspace[] {
    return this.props.workspaces;
  }

  async settings(): Promise<Settings> {
    const stored = await this.deps.kv.get<Partial<Settings>>(
      settingsKey(this.props.accountId),
      "json",
    );

    const known = stored?.defaultWorkspaceId;

    return {
      defaultWorkspaceId:
        known && this.findWorkspace(known)
          ? known
          : this.props.workspaces[0].workspaceId,
    };
  }

  async updateSettings(set: Partial<Settings>): Promise<Settings> {
    const current = await this.settings();
    const next: Settings = { ...current, ...set };

    if (!this.findWorkspace(next.defaultWorkspaceId)) {
      throw new Error("That workspace is not linked to this account.");
    }

    await this.deps.kv.put(
      settingsKey(this.props.accountId),
      JSON.stringify(next),
    );

    return next;
  }

  /** Resolves a requested workspace, falling back to the saved default. */
  async workspace(workspaceId?: string): Promise<LinkedWorkspace> {
    const id = workspaceId ?? (await this.settings()).defaultWorkspaceId;
    const workspace = this.findWorkspace(id);

    if (!workspace) {
      throw new Error(
        `Workspace ${id} is not linked. Linked workspaces: ${this.props.workspaces
          .map((item) => item.workspaceId)
          .join(", ")}.`,
      );
    }

    return workspace;
  }

  async client(workspaceId?: string): Promise<WorkspaceClient> {
    const workspace = await this.workspace(workspaceId);
    const token = await this.accessToken();

    return new WorkspaceClient(
      workspace.endpoint,
      token.accessToken,
      this.deps.fetch,
    );
  }

  async accessToken(): Promise<OrchestratorToken> {
    const cacheKey = this.props.sealedApiKey.data;
    const cached = tokenCache.get(cacheKey);

    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return cached;
    }

    const apiKey = await open(
      this.props.sealedApiKey,
      this.deps.encryptionKey,
      this.props.accountId,
    );

    const token = await exchangeApiKey(
      this.deps.cloudUrl,
      apiKey,
      this.deps.fetch,
    );

    tokenCache.set(cacheKey, token);

    return token;
  }

  private findWorkspace(id: string): LinkedWorkspace | undefined {
    return this.props.workspaces.find((item) => item.workspaceId === id);
  }
}

function settingsKey(accountId: string): string {
  return `app:settings:${accountId}`;
}
