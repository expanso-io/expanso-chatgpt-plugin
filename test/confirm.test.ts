import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  PLAN_TTL_SECONDS,
  signPlan,
  verifyPlan,
  type SignedPlan,
} from "../src/mcp/confirm.js";
import { TEST_ENCRYPTION_KEY } from "./helpers.js";

const PLAN: SignedPlan = {
  action: "stop_job",
  workspaceId: "ws1",
  preview: { jobId: "job-1", targetNodes: ["node-a"], summary: "Stop it." },
};

const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");

describe("change confirmation tokens", () => {
  it("verifies the plan it signed", async () => {
    const token = await signPlan(TEST_ENCRYPTION_KEY, "acct", PLAN);

    await expect(
      verifyPlan(TEST_ENCRYPTION_KEY, "acct", token, PLAN),
    ).resolves.toBeUndefined();
  });

  it("expires after the preview window", async () => {
    const signedAt = Date.now() - (PLAN_TTL_SECONDS + 5) * 1000;
    const token = await signPlan(TEST_ENCRYPTION_KEY, "acct", PLAN, signedAt);

    await expect(
      verifyPlan(TEST_ENCRYPTION_KEY, "acct", token, PLAN),
    ).rejects.toThrow(/preview expired/);
  });

  it("is bound to the service key, the account, and the workspace", async () => {
    const token = await signPlan(TEST_ENCRYPTION_KEY, "acct", PLAN);

    await expect(verifyPlan(OTHER_KEY, "acct", token, PLAN)).rejects.toThrow();

    await expect(
      verifyPlan(TEST_ENCRYPTION_KEY, "acct-2", token, PLAN),
    ).rejects.toThrow();

    await expect(
      verifyPlan(TEST_ENCRYPTION_KEY, "acct", token, {
        ...PLAN,
        workspaceId: "ws2",
      }),
    ).rejects.toThrow();
  });

  it("refuses tokens that were never signed", async () => {
    for (const token of ["", "v1", "v2.1.abc", "v1.notanumber.abc"]) {
      await expect(
        verifyPlan(TEST_ENCRYPTION_KEY, "acct", token, PLAN),
      ).rejects.toThrow(/was not previewed/);
    }
  });

  it("canonicalizes key order and insignificant whitespace only", () => {
    expect(canonicalJson({ b: 1, a: "x \r\ny  " })).toBe(
      canonicalJson({ a: "x\ny", b: 1 }),
    );

    expect(canonicalJson({ a: "x y" })).not.toBe(canonicalJson({ a: "xy" }));
  });
});
