import type { OpenAIMentionItem } from "@openai/mcp-extensions/server";
import type { WorkspaceClient } from "../cloud/client.js";
import { jobUri, jobView, nodeUri, nodeView } from "./views.js";

export const MENTION_LIMIT = 20;

const PER_KIND_LIMIT = 10;

type MentionClient = Pick<WorkspaceClient, "listJobs" | "listNodes">;

interface ParsedQuery {
  kinds: Array<"job" | "node">;
  prefix: string;
}

/**
 * "@job ingest" searches jobs, "@node edge-7" searches nodes, and anything
 * else searches both. Expanso filters by ID or name prefix.
 */
export function parseMentionQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  const match = /^(jobs?|nodes?)(?:[:\s]+(.*))?$/i.exec(trimmed);

  if (match) {
    const kind = match[1].toLowerCase().startsWith("job") ? "job" : "node";

    return { kinds: [kind], prefix: (match[2] ?? "").trim() };
  }

  return { kinds: ["job", "node"], prefix: trimmed };
}

export async function searchMentions(
  client: MentionClient,
  workspaceId: string,
  query: string,
): Promise<OpenAIMentionItem[]> {
  const { kinds, prefix } = parseMentionQuery(query);
  const safePrefix = /^[A-Za-z0-9._-]*$/.test(prefix) ? prefix : "";

  if (prefix !== safePrefix) return [];

  const [jobs, nodes] = await Promise.all([
    kinds.includes("job")
      ? client.listJobs({ prefix: safePrefix, limit: PER_KIND_LIMIT })
      : Promise.resolve({ items: [] }),
    kinds.includes("node")
      ? client.listNodes({ prefix: safePrefix, limit: PER_KIND_LIMIT })
      : Promise.resolve({ items: [] }),
  ]);

  const items: OpenAIMentionItem[] = [];

  for (const job of (jobs.items ?? []).map(jobView)) {
    if (!job.id) continue;
    items.push({
      type: "resource_link",
      uri: jobUri(workspaceId, job.id),
      name: job.name ?? job.id,
      title: `Job ${job.name ?? job.id}`,
      description: `${job.type ?? "job"}, ${job.state}`,
      mimeType: "text/markdown",
    });
  }

  for (const node of (nodes.items ?? []).map(nodeView)) {
    if (!node.id) continue;
    items.push({
      type: "resource_link",
      uri: nodeUri(workspaceId, node.id),
      name: node.name ?? node.id,
      title: `Node ${node.name ?? node.id}`,
      description: node.online ? "online" : node.connectionState,
      mimeType: "text/markdown",
    });
  }

  return items.slice(0, MENTION_LIMIT);
}
