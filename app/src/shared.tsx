import { App } from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import type { z } from "zod";
import type { JsonObject } from "../../src/cloud/types.js";
import {
  ConnectionStateSchema,
  type ConnectionStateView,
} from "../../src/mcp/contracts.js";

export const app = new App({ name: "expanso-fleet", version: "0.2.0" });

export const openai = new OpenAIExtensions(app);

/** The workspace cannot be read until it is connected or reconnected. */
export class ConnectionNeeded extends Error {
  constructor(readonly connection: ConnectionStateView["connection"]) {
    super(connection.message);
    this.name = "ConnectionNeeded";
  }
}

export async function callTool<Schema extends z.ZodType>(
  name: string,
  args: JsonObject,
  schema: Schema,
): Promise<z.output<Schema>> {
  const response = await app.callServerTool({ name, arguments: args });

  if (response.isError) {
    const text = response.content.find((item) => item.type === "text");
    throw new Error(text && "text" in text ? text.text : "The request failed.");
  }

  const connection = ConnectionStateSchema.safeParse(
    response.structuredContent,
  );

  if (connection.success) {
    throw new ConnectionNeeded(connection.data.connection);
  }

  const parsed = schema.safeParse(response.structuredContent);

  if (!parsed.success) throw new Error("The response was not understood.");

  return parsed.data;
}

export async function ask(text: string): Promise<void> {
  const content = [{ type: "text" as const, text }];

  if (openai.message) await openai.message.send({ role: "user", content });
  else await app.sendMessage({ role: "user", content });
}

const STATE_TONE = new Map([
  ["running", "good"],
  ["completed", "good"],
  ["connected", "good"],
  ["degraded", "warn"],
  ["queued", "warn"],
  ["deploying", "warn"],
  ["rollout_paused", "warn"],
  ["connecting", "warn"],
  ["stopping", "warn"],
  ["failed", "bad"],
  ["rollout_failed", "bad"],
  ["lost", "bad"],
  ["disconnected", "bad"],
]);

export function State({ value }: { value: string }) {
  return (
    <span className={`state state-${STATE_TONE.get(value) ?? "none"}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

export function ago(iso?: string): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);

  if (!Number.isFinite(seconds)) return "";

  if (seconds < 90) return "just now";

  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;

  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;

  return `${Math.round(seconds / 86400)} d ago`;
}

export function errorText(
  error: Error | undefined,
  fallback = "The request failed.",
): string {
  return error?.message || fallback;
}
