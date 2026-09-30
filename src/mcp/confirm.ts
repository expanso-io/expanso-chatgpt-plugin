// Every change to Expanso runs in two steps. A read-only plan tool builds the
// preview on the server (names, target nodes, diff) and signs it; the write
// tool takes that preview as its arguments, so ChatGPT's confirm step shows
// exactly what will happen, plus the signature. The write only runs when the
// arguments match what the server signed, for this account, within
// PLAN_TTL_SECONDS. Nothing the model writes into the arguments can widen
// the change past what was previewed.

import {
  isJsonArray,
  isJsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from "../cloud/types.js";

const encoder = new TextEncoder();

export const PLAN_TTL_SECONDS = 600;

const TOKEN_VERSION = "v1";

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** What a signature covers. `preview` is every argument the user confirms. */
export interface SignedPlan {
  action: string;
  workspaceId: string;
  preview: JsonObject;
}

async function hmacKey(base64Key: string): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0));

  // A separate key for signing, derived so the sealing key is never reused.
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, [
    "deriveKey",
  ]);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode("expanso-fleet confirm v1"),
    },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

/**
 * JSON with sorted keys, no undefined values, and line endings and trailing
 * spaces normalized, so a model that re-emits the preview's arguments with
 * insignificant whitespace changes still matches.
 */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: JsonValue): JsonValue {
  if (isJsonArray(value)) return value.map(normalize);

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }

  const text = jsonText(value);

  if (text === undefined) return value;

  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function message(accountId: string, expires: number, plan: SignedPlan) {
  return encoder.encode(
    [
      TOKEN_VERSION,
      accountId,
      String(expires),
      canonicalJson({
        action: plan.action,
        workspaceId: plan.workspaceId,
        preview: plan.preview,
      }),
    ].join("\n"),
  );
}

function toBase64Url(bytes: ArrayBuffer): string {
  let binary = "";

  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function signPlan(
  base64Key: string,
  accountId: string,
  plan: SignedPlan,
  now: number = Date.now(),
): Promise<string> {
  const expires = Math.floor(now / 1000) + PLAN_TTL_SECONDS;

  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(base64Key),
    message(accountId, expires, plan),
  );

  return `${TOKEN_VERSION}.${expires}.${toBase64Url(mac)}`;
}

/** Throws PlanError unless the token signs exactly this plan and is current. */
export async function verifyPlan(
  base64Key: string,
  accountId: string,
  token: string,
  plan: SignedPlan,
  now: number = Date.now(),
): Promise<void> {
  const [version, expiresText, mac] = token.split(".");
  const expires = Number(expiresText);

  if (version !== TOKEN_VERSION || !Number.isInteger(expires) || !mac) {
    throw new PlanError(
      "This change was not previewed. Run its plan tool first and confirm the preview it returns.",
    );
  }

  if (expires * 1000 < now) {
    throw new PlanError(
      "This preview expired. Run the plan tool again and confirm the new preview.",
    );
  }

  let signature: Uint8Array<ArrayBuffer>;

  try {
    signature = fromBase64Url(mac);
  } catch {
    throw new PlanError("The confirmation token is malformed.");
  }

  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(base64Key),
    signature,
    message(accountId, expires, plan),
  );

  if (!valid) {
    throw new PlanError(
      "These arguments differ from the preview that was signed. Run the plan tool again and pass its preview unchanged.",
    );
  }
}

/** Short, stable fingerprint of a spec, so a stale preview is refused. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));

  return toBase64Url(digest).slice(0, 16);
}
