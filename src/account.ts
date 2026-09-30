import { z } from "zod";
import { CloudFleetDirectory, type FleetDirectory } from "./cloud/directory.js";
import { signPlan, verifyPlan, type SignedPlan } from "./mcp/confirm.js";
import {
  CloudApiError,
  exchangeApiKey,
  parseJson,
  WorkspaceClient,
  type FetchLike,
  type OrchestratorToken,
} from "./cloud/client.js";
import { revokeWorkspaceKey } from "./cloud/connect.js";
import { apiKeysPageUrl } from "./config.js";
import { ConnectionStore, type Connection } from "./connections.js";
import { open } from "./crypto.js";
import { createAddLink } from "./links.js";

const LinkedWorkspaceSchema = z.object({
  workspaceId: z.string().min(1),
  endpoint: z.string().min(1),
  name: z.string().optional(),
});

/**
 * Data stored with the OAuth grant: who the account is, never a key. The
 * library encrypts it at rest and hands it back on each request, where it is
 * parsed again before use.
 */
export const GrantPropsSchema = z.object({
  /** Stable, opaque account ID: one per Expanso user and organization. */
  accountId: z.string().min(1),
  organizationId: z.string().min(1),
  email: z.string().optional(),
  /**
   * Grants made before keys moved to the connection store carried the key
   * and workspaces here. They are copied into the store once; see migrate.
   */
  sealedApiKey: z
    .object({ v: z.literal(1), iv: z.string(), data: z.string() })
    .optional(),
  workspaces: z.array(LinkedWorkspaceSchema).optional(),
});

export type GrantProps = z.infer<typeof GrantPropsSchema>;

export type LinkedWorkspace = z.infer<typeof LinkedWorkspaceSchema>;

/** Tools start warning this many days before a key expires. */
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Why tools cannot read a workspace, with the one action that fixes it. */
export interface ConnectionState {
  status: "not_connected" | "reconnect";
  workspaceId?: string;
  message: string;
  reconnectUrl: string;
}

export class ConnectionRequired extends Error {
  constructor(readonly state: ConnectionState) {
    super(state.message);
    this.name = "ConnectionRequired";
  }
}

/** The active workspace, ready to read. */
export interface Session {
  workspace: LinkedWorkspace;
  client: WorkspaceClient;
  accessToken: string;
  /** A warning to pass on, such as a key that expires soon. */
  notice?: string;
}

export interface DisconnectOutcome {
  removed: Connection;
  active?: Connection;
  /** True only when Expanso Cloud confirmed the key is revoked. */
  revoked: boolean;
  keysPageUrl: string;
}

const SavedSettingsSchema = z.object({ defaultWorkspaceId: z.string() });

// Orchestrator tokens live only in isolate memory and expire within an hour.
const tokenCache = new Map<string, OrchestratorToken>();

const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface AccountDeps {
  kv: KVNamespace;
  encryptionKey: string;
  cloudUrl: string;
  publicBaseUrl: string;
  consoleUrl: string;
  fetch?: FetchLike;
  now?: () => Date;
}

/** Everything a tool call needs about the signed-in account. */
export class Account {
  readonly store: ConnectionStore;

  private migrated?: Promise<void>;

  constructor(
    readonly props: GrantProps,
    private readonly deps: AccountDeps,
  ) {
    this.store = new ConnectionStore(props.accountId, {
      kv: deps.kv,
      encryptionKey: deps.encryptionKey,
      now: deps.now,
    });
  }

  async connections(): Promise<Connection[]> {
    await this.migrate();

    return this.store.list();
  }

  async activeConnection(): Promise<Connection | undefined> {
    return (await this.connections()).find((item) => item.active);
  }

  /**
   * Opens the active workspace. Throws ConnectionRequired when nothing is
   * connected or Expanso Cloud stopped accepting the workspace's key.
   */
  async session(): Promise<Session> {
    const active = await this.activeConnection();

    if (!active) throw new ConnectionRequired(await this.notConnected());

    if (active.needsReconnect) {
      throw new ConnectionRequired(await this.reconnect(active));
    }

    const token = await this.token(active);

    await this.store.touch(active.workspaceId);

    const workspace: LinkedWorkspace = {
      workspaceId: active.workspaceId,
      endpoint: active.endpoint,
    };

    if (active.name !== undefined) workspace.name = active.name;

    return {
      workspace,
      client: new WorkspaceClient(
        active.endpoint,
        token.accessToken,
        this.deps.fetch,
      ),
      accessToken: token.accessToken,
      notice: expiryNotice(active, this.now()),
    };
  }

  async switchWorkspace(workspaceId: string): Promise<Connection> {
    await this.migrate();

    return this.store.switchTo(workspaceId);
  }

  async disconnect(workspaceId: string): Promise<DisconnectOutcome> {
    await this.migrate();

    const { removed, active } = await this.store.disconnect(workspaceId);

    for (const key of tokenCache.keys()) {
      if (key.startsWith(`${this.props.accountId}:${workspaceId}:`)) {
        tokenCache.delete(key);
      }
    }

    const { revoked } = await revokeWorkspaceKey();

    return {
      removed,
      active,
      revoked,
      keysPageUrl: apiKeysPageUrl(this.deps.consoleUrl),
    };
  }

  /**
   * A one-time link to the page where a workspace is connected or
   * reconnected. Naming a known workspace fills in its endpoint.
   */
  async addLink(
    workspaceId?: string,
  ): Promise<{ url: string; expiresAt: string }> {
    const known =
      workspaceId === undefined
        ? undefined
        : (await this.connections()).find(
            (item) => item.workspaceId === workspaceId,
          );

    return createAddLink(
      {
        kv: this.deps.kv,
        publicBaseUrl: this.deps.publicBaseUrl,
        now: () => this.now().getTime(),
      },
      this.props.accountId,
      known?.endpoint,
    );
  }

  /** Signs a change preview for this account; see mcp/confirm.ts. */
  signPlan(plan: SignedPlan): Promise<string> {
    return signPlan(this.deps.encryptionKey, this.props.accountId, plan);
  }

  verifyPlan(token: string, plan: SignedPlan): Promise<void> {
    return verifyPlan(
      this.deps.encryptionKey,
      this.props.accountId,
      token,
      plan,
    );
  }

  /**
   * Every workspace this person can reach, from Expanso Cloud, read with the
   * active workspace's token.
   */
  directory(): FleetDirectory {
    return new CloudFleetDirectory(
      this.deps.cloudUrl,
      async () => (await this.session()).accessToken,
      this.deps.fetch,
    );
  }

  private async token(active: Connection): Promise<OrchestratorToken> {
    const fingerprint = await this.store.keyFingerprint(active.workspaceId);
    const cacheKey = `${this.props.accountId}:${active.workspaceId}:${fingerprint}`;
    const cached = tokenCache.get(cacheKey);

    if (
      cached &&
      cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > this.now().getTime()
    ) {
      return cached;
    }

    let token: OrchestratorToken;

    try {
      token = await exchangeApiKey(
        this.deps.cloudUrl,
        await this.store.apiKey(active.workspaceId),
        this.deps.fetch,
      );
    } catch (error) {
      // 401 means Cloud no longer accepts the key: revoked or expired.
      if (error instanceof CloudApiError && error.status === 401) {
        await this.store.markNeedsReconnect(active.workspaceId);

        throw new ConnectionRequired(await this.reconnect(active));
      }

      throw error;
    }

    tokenCache.set(cacheKey, token);

    return token;
  }

  private async reconnect(active: Connection): Promise<ConnectionState> {
    const link = await this.addLink(active.workspaceId);

    return {
      status: "reconnect",
      workspaceId: active.workspaceId,
      message: `Expanso Cloud no longer accepts the API key for workspace ${active.workspaceId}; it was revoked or it expired. Reconnect the workspace with a new key to keep reading it.`,
      reconnectUrl: link.url,
    };
  }

  private async notConnected(): Promise<ConnectionState> {
    const link = await this.addLink();

    return {
      status: "not_connected",
      message:
        "No Expanso workspace is connected. Connect one to read its nodes and jobs.",
      reconnectUrl: link.url,
    };
  }

  /**
   * Copies the key and workspaces of a grant made before the connection
   * store into the store, once. A marker keeps a later disconnect or expiry
   * from bringing them back.
   */
  private migrate(): Promise<void> {
    this.migrated ??= this.migrateOnce();

    return this.migrated;
  }

  private async migrateOnce(): Promise<void> {
    const { accountId, sealedApiKey, workspaces } = this.props;

    if (!sealedApiKey || !workspaces || workspaces.length === 0) return;

    const marker = `app:legacy:${accountId}`;

    if ((await this.deps.kv.get(marker)) !== null) return;

    if (!(await this.store.exists())) {
      const apiKey = await open(
        sealedApiKey,
        this.deps.encryptionKey,
        accountId,
      );

      const saved = parseJson(
        (await this.deps.kv.get(`app:settings:${accountId}`)) ?? "",
        SavedSettingsSchema,
      );

      const preferred = saved.success
        ? workspaces.find(
            (item) => item.workspaceId === saved.data.defaultWorkspaceId,
          )
        : undefined;

      await this.store.replaceAll(
        workspaces.map((item) => ({ ...item, apiKey })),
        (preferred ?? workspaces[0]).workspaceId,
      );
    }

    await this.deps.kv.put(marker, "migrated");
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** Warns when the key expires within EXPIRY_WARNING_DAYS or has expired. */
export function expiryNotice(
  connection: Pick<Connection, "workspaceId" | "keyExpiresAt">,
  now: Date,
): string | undefined {
  if (connection.keyExpiresAt === undefined) return undefined;

  const expiresAt = Date.parse(connection.keyExpiresAt);

  if (!Number.isFinite(expiresAt)) return undefined;

  if (expiresAt <= now.getTime()) {
    return `The API key for workspace ${connection.workspaceId} expired on ${connection.keyExpiresAt.slice(0, 10)}. Reconnect the workspace with a new key to keep access.`;
  }

  const days = Math.ceil((expiresAt - now.getTime()) / DAY_MS);

  if (days > EXPIRY_WARNING_DAYS) return undefined;

  const when =
    days <= 1
      ? "within a day"
      : `in ${days} days, on ${connection.keyExpiresAt.slice(0, 10)}`;

  return `The API key for workspace ${connection.workspaceId} expires ${when}. Reconnect the workspace with a new key before then to keep access.`;
}
