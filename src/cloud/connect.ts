import { z } from "zod";

/**
 * The ChatGPT connect API Expanso Cloud is expected to serve once
 * expanso-io/expanso-cloud#1967 lands. Nothing calls it yet: until then people
 * paste a key, and this file records the contract the plugin will wire to.
 */
export const CONNECT_TOKEN_PATH = "/api/v1/connect/chatgpt/token";

/**
 * Expected answer to the one-time code exchange at CONNECT_TOKEN_PATH. Only
 * these fields are named by the Cloud proposal; confirm them when it merges.
 */
export const ConnectTokenResponseSchema = z.object({
  api_key: z.string().startsWith("exp_ak_"),
  key_id: z.string().min(1),
  /** RFC 3339 time after which Cloud stops accepting the key. */
  expires_at: z.string().optional(),
  workspace_id: z.string().min(1),
  workspace_endpoint: z.string().min(1),
});

export type ConnectTokenResponse = z.infer<typeof ConnectTokenResponseSchema>;

export interface RevokeOutcome {
  /** True only when Expanso Cloud confirmed the key is revoked. */
  revoked: boolean;
}

/**
 * The single place a cached key will be revoked in Expanso Cloud when
 * Disconnect runs. Cloud has no API for that yet, so nothing is revoked and
 * the caller tells the person to revoke the key on the workspace's Keys page.
 */
export function revokeWorkspaceKey(): Promise<RevokeOutcome> {
  return Promise.resolve({ revoked: false });
}
