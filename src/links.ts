import { z } from "zod";
import { parseJson } from "./cloud/client.js";

/** How long an add-workspace link works. */
export const ADD_LINK_TTL_SECONDS = 10 * 60;

export const ADD_WORKSPACE_PATH = "/workspaces/add";

const AddLinkSchema = z.object({
  accountId: z.string().min(1),
  /** Endpoint to suggest, when the link reconnects a known workspace. */
  endpoint: z.string().optional(),
  expiresAt: z.number(),
});

export type AddLink = z.infer<typeof AddLinkSchema>;

export interface LinkDeps {
  kv: KVNamespace;
  publicBaseUrl: string;
  now?: () => number;
}

/**
 * Mints a one-time link to the add-workspace page for one account. Only a
 * hash of the token is stored, and the record expires with the link, so a KV
 * listing never yields a working link.
 */
export async function createAddLink(
  deps: LinkDeps,
  accountId: string,
  endpoint?: string,
): Promise<{ url: string; expiresAt: string }> {
  const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = (deps.now?.() ?? Date.now()) + ADD_LINK_TTL_SECONDS * 1000;
  const link: AddLink = { accountId, expiresAt };

  if (endpoint !== undefined) link.endpoint = endpoint;

  await deps.kv.put(await linkKey(token), JSON.stringify(link), {
    expirationTtl: ADD_LINK_TTL_SECONDS,
  });

  const url = new URL(ADD_WORKSPACE_PATH, deps.publicBaseUrl);

  url.searchParams.set("token", token);

  return { url: url.href, expiresAt: new Date(expiresAt).toISOString() };
}

/** The link a token stands for, or undefined when it expired or was used. */
export async function readAddLink(
  deps: Pick<LinkDeps, "kv" | "now">,
  token: string,
): Promise<AddLink | undefined> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;

  const raw = await deps.kv.get(await linkKey(token));

  if (raw === null) return undefined;

  const parsed = parseJson(raw, AddLinkSchema);

  if (!parsed.success) return undefined;

  // KV expiry is eventual, so the stored deadline is checked as well.
  return parsed.data.expiresAt > (deps.now?.() ?? Date.now())
    ? parsed.data
    : undefined;
}

/** Spends a link so it cannot add another workspace. */
export async function consumeAddLink(
  deps: Pick<LinkDeps, "kv">,
  token: string,
): Promise<void> {
  await deps.kv.delete(await linkKey(token));
}

async function linkKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );

  return `app:addlink:${toBase64Url(new Uint8Array(digest))}`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
