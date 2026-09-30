import { describe, expect, it } from "vitest";
import { parseWorkspaceEndpoint } from "../src/config.js";
import { open, seal } from "../src/crypto.js";
import { TEST_ENCRYPTION_KEY } from "./helpers.js";

const SUFFIXES = [".expanso.io"];

describe("parseWorkspaceEndpoint", () => {
  it("accepts the endpoint forms Expanso Cloud shows", () => {
    expect(
      parseWorkspaceEndpoint("ws1.us1.cloud.expanso.io:9010", SUFFIXES),
    ).toEqual({
      workspaceId: "ws1",
      endpoint: "ws1.us1.cloud.expanso.io:9010",
    });
    expect(
      parseWorkspaceEndpoint(" https://WS1.us2.expanso.io/ ", SUFFIXES),
    ).toEqual({
      workspaceId: "ws1",
      endpoint: "ws1.us2.expanso.io",
    });
  });

  it.each([
    "expanso.io",
    "us1.expanso.io.attacker.net",
    "ws1.us1.cloud.expanso.io:99999",
    "http://ws1.us1.cloud.expanso.io",
    "ws1.us1.cloud.expanso.io/api",
    "a@ws1.us1.cloud.expanso.io",
    "ws_1.us1.cloud.expanso.io",
    "localhost:9010",
  ])("rejects %s", (raw) => {
    expect(() => parseWorkspaceEndpoint(raw, SUFFIXES)).toThrow();
  });
});

describe("sealed API keys", () => {
  it("round-trips for the owner only", async () => {
    const sealed = await seal("exp_ak_value", TEST_ENCRYPTION_KEY, "owner-a");
    expect(JSON.stringify(sealed)).not.toContain("exp_ak_value");
    expect(await open(sealed, TEST_ENCRYPTION_KEY, "owner-a")).toBe(
      "exp_ak_value",
    );
    await expect(
      open(sealed, TEST_ENCRYPTION_KEY, "owner-b"),
    ).rejects.toThrow();
  });

  it("requires a 32 byte key", async () => {
    await expect(
      seal("x", Buffer.alloc(16).toString("base64"), "o"),
    ).rejects.toThrow(/32 bytes/);
  });
});
