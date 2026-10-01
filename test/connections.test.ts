import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPlatformProxy, type PlatformProxy } from "wrangler";
import {
  Account,
  ConnectionRequired,
  expiryNotice,
  type GrantProps,
} from "../src/account.js";
import type { Env } from "../src/config.js";
import { CONNECTION_TTL_SECONDS, ConnectionStore } from "../src/connections.js";
import { seal } from "../src/crypto.js";
import { consumeAddLink, createAddLink, readAddLink } from "../src/links.js";
import {
  TEST_ENCRYPTION_KEY,
  fakeFetch,
  serveToken,
  type Route,
} from "./helpers.js";

const CLOUD = "https://cloud.test";

const KEY_1 = "exp_ak_fixture_key_one";

const KEY_2 = "exp_ak_fixture_key_two";

const HOUR_MS = 60 * 60 * 1000;

let platform: PlatformProxy<Env>;

let kv: KVNamespace;

beforeAll(async () => {
  platform = await getPlatformProxy<Env>({ persist: false });
  kv = platform.env.OAUTH_KV;
});

afterAll(async () => {
  await platform?.dispose();
});

let accounts = 0;

/** A fresh account ID per test, so tests never share KV records. */
function nextAccountId(): string {
  accounts += 1;

  return `acct${accounts}`;
}

function clock(start = Date.parse("2026-10-01T00:00:00Z")) {
  let now = start;

  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("ConnectionStore", () => {
  const store = (accountId = nextAccountId(), now = clock().now) =>
    new ConnectionStore(accountId, {
      kv,
      encryptionKey: TEST_ENCRYPTION_KEY,
      now,
    });

  it("makes each added workspace active and keeps the others' keys", async () => {
    const connections = store();

    await connections.add({
      workspaceId: "ws1",
      endpoint: "ws1.us1.cloud.expanso.io:9010",
      apiKey: KEY_1,
    });

    await connections.add({
      workspaceId: "ws2",
      endpoint: "ws2.us1.cloud.expanso.io:9010",
      apiKey: KEY_2,
    });

    expect(
      (await connections.list()).map((item) => [item.workspaceId, item.active]),
    ).toEqual([
      ["ws1", false],
      ["ws2", true],
    ]);

    await connections.switchTo("ws1");

    expect((await connections.active())?.workspaceId).toBe("ws1");

    // Switching leaves every cached key in place.
    expect(await connections.apiKey("ws1")).toBe(KEY_1);
    expect(await connections.apiKey("ws2")).toBe(KEY_2);
  });

  it("refuses to switch to a workspace that is not connected", async () => {
    const connections = store();

    await connections.add({ workspaceId: "ws1", endpoint: "e", apiKey: KEY_1 });

    await expect(connections.switchTo("ws9")).rejects.toThrow(
      "Workspace ws9 is not connected. Connected: ws1.",
    );
  });

  it("stores keys sealed and expires the record after 30 days unused", async () => {
    const accountId = nextAccountId();
    const before = Math.floor(Date.now() / 1000);

    await store(accountId).add({
      workspaceId: "ws1",
      endpoint: "e",
      apiKey: KEY_1,
    });

    const { keys } = await kv.list({ prefix: `app:conn:${accountId}` });

    expect(keys).toHaveLength(1);
    expect(keys[0].expiration).toBeGreaterThanOrEqual(
      before + CONNECTION_TTL_SECONDS,
    );
    expect(await kv.get(keys[0].name)).not.toContain(KEY_1);
  });

  it("refreshes the expiry on use at most once every 12 hours", async () => {
    const time = clock();
    const accountId = nextAccountId();
    const connections = store(accountId, time.now);

    await connections.add({ workspaceId: "ws1", endpoint: "e", apiKey: KEY_1 });

    const lastUsed = async () => (await connections.active())?.lastUsedAt;
    const linked = await lastUsed();

    time.advance(11 * HOUR_MS);
    await connections.touch("ws1");

    expect(await lastUsed()).toBe(linked);

    time.advance(2 * HOUR_MS);
    await connections.touch("ws1");

    expect(await lastUsed()).toBe(time.now().toISOString());
  });

  it("disconnects a workspace and falls back to the most recently used one", async () => {
    const time = clock();
    const accountId = nextAccountId();
    const connections = store(accountId, time.now);

    for (const workspaceId of ["ws1", "ws2", "ws3"]) {
      await connections.add({ workspaceId, endpoint: "e", apiKey: KEY_1 });
      time.advance(HOUR_MS);
    }

    await connections.switchTo("ws1");
    time.advance(HOUR_MS);
    await connections.switchTo("ws3");

    const { removed, active } = await connections.disconnect("ws3");

    expect(removed.workspaceId).toBe("ws3");
    expect(active?.workspaceId).toBe("ws1");
    await expect(connections.apiKey("ws3")).rejects.toThrow("not connected");

    await connections.disconnect("ws1");
    await connections.disconnect("ws2");

    expect(await connections.list()).toEqual([]);
    expect(await kv.get(`app:conn:${accountId}`)).toBeNull();
  });
});

describe("Account", () => {
  const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

  function account(
    props: GrantProps,
    routes: Record<string, Route> = {
      [`POST ${CLOUD}/api/v1/auth/token`]: serveToken("claims-org-wide.json"),
    },
    now = clock().now,
  ) {
    const cloud = fakeFetch(routes);

    return {
      cloud,
      account: new Account(props, {
        kv,
        encryptionKey: TEST_ENCRYPTION_KEY,
        cloudUrl: CLOUD,
        publicBaseUrl: "https://fleet.test",
        consoleUrl: "https://console.test",
        fetch: cloud.fetch,
        now,
      }),
    };
  }

  it("moves a grant made before the connection store into the store, once", async () => {
    const accountId = nextAccountId();

    await kv.put(
      `app:settings:${accountId}`,
      JSON.stringify({ defaultWorkspaceId: "ws2" }),
    );

    const legacy: GrantProps = {
      accountId,
      organizationId: "org_fixture",
      sealedApiKey: await seal(KEY_1, TEST_ENCRYPTION_KEY, accountId),
      workspaces: [
        { workspaceId: "ws1", endpoint: ENDPOINT },
        { workspaceId: "ws2", endpoint: "ws2.us1.cloud.expanso.io:9010" },
      ],
    };

    const first = account(legacy).account;

    expect(
      (await first.connections()).map((item) => [
        item.workspaceId,
        item.active,
      ]),
    ).toEqual([
      ["ws1", false],
      ["ws2", true],
    ]);

    expect(await first.store.apiKey("ws1")).toBe(KEY_1);

    await first.disconnect("ws1");
    await first.disconnect("ws2");

    // A later request with the same grant does not bring them back.
    expect(await account(legacy).account.connections()).toEqual([]);
  });

  it("explains how to connect when no workspace is connected", async () => {
    const { account: empty, cloud } = account({
      accountId: nextAccountId(),
      organizationId: "org_fixture",
    });

    const error = await empty.session().then(
      () => undefined,
      (caught: ConnectionRequired) => caught,
    );

    expect(error).toBeInstanceOf(ConnectionRequired);
    expect(error?.state.status).toBe("not_connected");
    expect(error?.state.reconnectUrl).toMatch(
      /^https:\/\/fleet\.test\/workspaces\/add\?token=[A-Za-z0-9_-]{43}$/,
    );
    expect(cloud.requests).toHaveLength(0);
  });

  it("warns in the session when the key expires within a week", async () => {
    const time = clock();
    const props = { accountId: nextAccountId(), organizationId: "org" };
    const { account: soon } = account(props, undefined, time.now);

    await soon.store.add({
      workspaceId: "ws1",
      endpoint: ENDPOINT,
      apiKey: KEY_1,
      keyExpiresAt: new Date(
        time.now().getTime() + 3 * 24 * HOUR_MS,
      ).toISOString(),
    });

    const session = await soon.session();

    expect(session.workspace.workspaceId).toBe("ws1");
    expect(session.notice).toBe(
      "The API key for workspace ws1 expires in 3 days, on 2026-10-04. Reconnect the workspace with a new key before then to keep access.",
    );
  });
});

describe("expiryNotice", () => {
  const now = new Date("2026-10-01T00:00:00Z");

  it.each([
    [undefined, undefined],
    ["2026-10-20T00:00:00Z", undefined],
    ["2026-10-08T00:00:00Z", "in 7 days, on 2026-10-08"],
    ["2026-10-01T12:00:00Z", "within a day"],
  ])("for a key expiring %s", (keyExpiresAt, phrase) => {
    const notice = expiryNotice({ workspaceId: "ws1", keyExpiresAt }, now);

    if (phrase === undefined) expect(notice).toBeUndefined();
    else expect(notice).toContain(`expires ${phrase}.`);
  });
});

describe("add-workspace links", () => {
  const deps = (now = Date.parse("2026-10-01T00:00:00Z")) => ({
    kv,
    publicBaseUrl: "https://fleet.test",
    now: () => now,
  });

  const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";

  it("works for the account it was made for, with a suggested endpoint", async () => {
    const accountId = nextAccountId();
    const { url } = await createAddLink(deps(), accountId, "ws1.example");

    expect(await readAddLink(deps(), tokenOf(url))).toMatchObject({
      accountId,
      endpoint: "ws1.example",
    });
  });

  it("stops working after ten minutes", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const { url } = await createAddLink(deps(start), nextAccountId());

    expect(
      await readAddLink(deps(start + 9 * 60 * 1000), tokenOf(url)),
    ).toBeDefined();
    expect(
      await readAddLink(deps(start + 10 * 60 * 1000), tokenOf(url)),
    ).toBeUndefined();
  });

  it("works once", async () => {
    const { url } = await createAddLink(deps(), nextAccountId());

    await consumeAddLink(deps(), tokenOf(url));

    expect(await readAddLink(deps(), tokenOf(url))).toBeUndefined();
  });

  it("ignores tokens that were never issued", async () => {
    expect(await readAddLink(deps(), "a".repeat(43))).toBeUndefined();
    expect(await readAddLink(deps(), "../../etc")).toBeUndefined();
  });
});
