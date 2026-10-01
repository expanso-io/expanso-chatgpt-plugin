import { z } from "zod";
import { parseJson } from "./cloud/client.js";
import { open, seal } from "./crypto.js";

/** A connection nobody uses for this long expires on its own. */
export const CONNECTION_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Use refreshes the expiry at most this often, to keep KV writes rare. */
export const TOUCH_INTERVAL_MS = 12 * 60 * 60 * 1000;

const SealedSecretSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  data: z.string(),
});

const ConnectionSchema = z.object({
  endpoint: z.string().min(1),
  name: z.string().optional(),
  sealedApiKey: SealedSecretSchema,
  /** Cloud's ID for the key, once Cloud issues keys for this plugin. */
  keyId: z.string().optional(),
  /** When Cloud stops accepting the key; absent for keys that never expire. */
  keyExpiresAt: z.string().optional(),
  linkedAt: z.string(),
  lastUsedAt: z.string(),
  /** Set when Cloud stopped accepting the key; cleared by reconnecting. */
  needsReconnect: z.boolean().optional(),
});

const StoreSchema = z.object({
  activeWorkspaceId: z.string().optional(),
  workspaces: z.record(z.string(), ConnectionSchema),
});

type StoredConnection = z.infer<typeof ConnectionSchema>;

type Store = z.infer<typeof StoreSchema>;

/** A cached workspace connection, without its key. */
export interface Connection {
  workspaceId: string;
  endpoint: string;
  name?: string;
  keyId?: string;
  keyExpiresAt?: string;
  linkedAt: string;
  lastUsedAt: string;
  needsReconnect: boolean;
  active: boolean;
}

export interface NewConnection {
  workspaceId: string;
  endpoint: string;
  name?: string;
  apiKey: string;
  keyId?: string;
  keyExpiresAt?: string;
}

export interface StoreDeps {
  kv: KVNamespace;
  encryptionKey: string;
  now?: () => Date;
}

/**
 * Every workspace an account has connected, each with its own sealed key, and
 * which one is active. One active workspace at a time; switching never touches
 * the other keys. The whole record expires after CONNECTION_TTL_SECONDS of
 * disuse, so a connection nobody opens goes away by itself.
 */
export class ConnectionStore {
  private readonly now: () => Date;

  constructor(
    readonly accountId: string,
    private readonly deps: StoreDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(): Promise<Connection[]> {
    const store = await this.load();

    return store ? toConnections(store) : [];
  }

  async active(): Promise<Connection | undefined> {
    return (await this.list()).find((connection) => connection.active);
  }

  /** Caches a key for a workspace and makes that workspace active. */
  async add(connection: NewConnection): Promise<Connection> {
    const store = (await this.load()) ?? { workspaces: {} };
    const now = this.now().toISOString();

    store.workspaces[connection.workspaceId] = {
      endpoint: connection.endpoint,
      name: connection.name,
      sealedApiKey: await seal(
        connection.apiKey.trim(),
        this.deps.encryptionKey,
        this.keyOwner(connection.workspaceId),
      ),
      keyId: connection.keyId,
      keyExpiresAt: connection.keyExpiresAt,
      linkedAt: now,
      lastUsedAt: now,
    };

    store.activeWorkspaceId = connection.workspaceId;
    await this.save(store);

    return this.require(store, connection.workspaceId);
  }

  /** Makes a cached workspace active. No key is revoked or replaced. */
  async switchTo(workspaceId: string): Promise<Connection> {
    const store = await this.load();

    if (!store?.workspaces[workspaceId]) {
      throw new Error(
        `Workspace ${workspaceId} is not connected. Connected: ${describeIds(store)}.`,
      );
    }

    store.activeWorkspaceId = workspaceId;
    store.workspaces[workspaceId].lastUsedAt = this.now().toISOString();
    await this.save(store);

    return this.require(store, workspaceId);
  }

  /**
   * Forgets a workspace's cached key. When it was active, the most recently
   * used remaining workspace becomes active.
   */
  async disconnect(workspaceId: string): Promise<{
    removed: Connection;
    active?: Connection;
  }> {
    const store = await this.load();

    if (!store?.workspaces[workspaceId]) {
      throw new Error(`Workspace ${workspaceId} is not connected.`);
    }

    const removed = this.require(store, workspaceId);

    delete store.workspaces[workspaceId];

    if (store.activeWorkspaceId === workspaceId) {
      store.activeWorkspaceId = mostRecent(store);
    }

    if (Object.keys(store.workspaces).length === 0) {
      await this.deps.kv.delete(this.key);

      return { removed: { ...removed, active: false } };
    }

    await this.save(store);

    const active = toConnections(store).find((item) => item.active);

    return { removed: { ...removed, active: false }, active };
  }

  /** Records that Cloud no longer accepts a workspace's key. */
  async markNeedsReconnect(workspaceId: string): Promise<void> {
    const store = await this.load();
    const connection = store?.workspaces[workspaceId];

    if (!store || !connection) return;

    connection.needsReconnect = true;
    await this.save(store);
  }

  /**
   * Notes that a workspace was used. The write, which also restarts the
   * inactivity expiry, happens at most once per TOUCH_INTERVAL_MS.
   */
  async touch(workspaceId: string): Promise<void> {
    const store = await this.load();
    const connection = store?.workspaces[workspaceId];

    if (!store || !connection) return;

    const now = this.now();

    if (now.getTime() - Date.parse(connection.lastUsedAt) < TOUCH_INTERVAL_MS) {
      return;
    }

    connection.lastUsedAt = now.toISOString();
    await this.save(store);
  }

  /** The workspace's API key, decrypted for one exchange with Cloud. */
  async apiKey(workspaceId: string): Promise<string> {
    const connection = (await this.load())?.workspaces[workspaceId];

    if (!connection)
      throw new Error(`Workspace ${workspaceId} is not connected.`);

    return open(
      connection.sealedApiKey,
      this.deps.encryptionKey,
      this.keyOwner(workspaceId),
    );
  }

  /** Identifies the sealed key's ciphertext, for caching tokens made from it. */
  async keyFingerprint(workspaceId: string): Promise<string | undefined> {
    return (await this.load())?.workspaces[workspaceId]?.sealedApiKey.data;
  }

  /** Writes a store wholesale; used once when an older grant is migrated. */
  async replaceAll(
    connections: readonly NewConnection[],
    activeWorkspaceId: string,
  ): Promise<void> {
    const now = this.now().toISOString();
    const store: Store = { activeWorkspaceId, workspaces: {} };

    for (const connection of connections) {
      store.workspaces[connection.workspaceId] = {
        endpoint: connection.endpoint,
        name: connection.name,
        sealedApiKey: await seal(
          connection.apiKey,
          this.deps.encryptionKey,
          this.keyOwner(connection.workspaceId),
        ),
        linkedAt: now,
        lastUsedAt: now,
      };
    }

    await this.save(store);
  }

  async exists(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  private get key(): string {
    return `app:conn:${this.accountId}`;
  }

  /** Binds each sealed key to its account and workspace. */
  private keyOwner(workspaceId: string): string {
    return `${this.accountId}:${workspaceId}`;
  }

  private async load(): Promise<Store | undefined> {
    const raw = await this.deps.kv.get(this.key);

    if (raw === null) return undefined;

    const parsed = parseJson(raw, StoreSchema);

    return parsed.success ? parsed.data : undefined;
  }

  private async save(store: Store): Promise<void> {
    await this.deps.kv.put(this.key, JSON.stringify(store), {
      expirationTtl: CONNECTION_TTL_SECONDS,
    });
  }

  private require(store: Store, workspaceId: string): Connection {
    const found = toConnections(store).find(
      (connection) => connection.workspaceId === workspaceId,
    );

    if (!found) throw new Error(`Workspace ${workspaceId} is not connected.`);

    return found;
  }
}

function toConnections(store: Store): Connection[] {
  return Object.entries(store.workspaces).map(([workspaceId, stored]) =>
    toConnection(workspaceId, stored, store.activeWorkspaceId === workspaceId),
  );
}

function toConnection(
  workspaceId: string,
  stored: StoredConnection,
  active: boolean,
): Connection {
  return {
    workspaceId,
    endpoint: stored.endpoint,
    name: stored.name,
    keyId: stored.keyId,
    keyExpiresAt: stored.keyExpiresAt,
    linkedAt: stored.linkedAt,
    lastUsedAt: stored.lastUsedAt,
    needsReconnect: stored.needsReconnect ?? false,
    active,
  };
}

function mostRecent(store: Store): string | undefined {
  return Object.entries(store.workspaces).sort(
    ([, a], [, b]) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt),
  )[0]?.[0];
}

function describeIds(store: Store | undefined): string {
  const ids = Object.keys(store?.workspaces ?? {});

  return ids.length > 0 ? ids.join(", ") : "none";
}
