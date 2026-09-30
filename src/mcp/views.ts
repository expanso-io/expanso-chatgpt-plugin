import type { Execution, HistoryEvent, Job, Node } from "../cloud/types.js";
import type {
  ExecutionView,
  HistoryView,
  JobView,
  NodeView,
} from "./contracts.js";

export type { ExecutionView, HistoryView, JobView, NodeView };

// Views trim orchestrator objects to what the model and the Fleet app need.
// Job specs and execution spec snapshots are deliberately left out: pipeline
// configuration can carry connection details that do not belong in a chat.

export function nodeView(node: Node): NodeView {
  const state = node.status?.connection_state ?? "unknown";
  const usage = node.status?.resource_usage;

  return {
    id: node.id ?? "",
    name: node.spec?.name,
    hostname: node.spec?.hostname,
    os: node.spec?.os,
    arch: node.spec?.arch,
    agentVersion: node.spec?.agent_version,
    connectionState: state,
    online: state === "connected",
    lastHeartbeat: node.status?.last_heartbeat,
    message: node.status?.message || undefined,
    labels: node.spec?.labels,
    cpuPercent: usage?.cpu_percent,
    memoryPercent: usage?.memory_percent,
    diskPercent: usage?.disk_percent,
  };
}

export function jobView(job: Job): JobView {
  return {
    id: job.id ?? "",
    name: job.spec?.name,
    type: job.spec?.type,
    state: job.status?.state?.state_type || "unknown",
    message: job.status?.state?.message || undefined,
    version: job.status?.version,
    updatedAt: job.status?.updated_at,
    labels: job.spec?.labels,
  };
}

export function executionView(execution: Execution): ExecutionView {
  const observed = execution.status?.observed_state;

  return {
    id: execution.id ?? "",
    jobId: execution.job_id,
    nodeId: execution.node_id,
    state: observed?.state_type ?? "unknown",
    message: observed?.message || undefined,
    desiredState: execution.status?.desired_state?.state_type,
    jobVersion: execution.job_version,
    updatedAt: execution.status?.updated_at,
    details: nonEmpty(execution.status?.details ?? observed?.details),
  };
}

export function historyView(event: HistoryEvent): HistoryView {
  return {
    timestamp: event.timestamp,
    message: event.message,
    executionId: event.execution_id,
    details: nonEmpty(event.details),
  };
}

function nonEmpty(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return record && Object.keys(record).length > 0 ? record : undefined;
}

/** Job states that need attention in the Fleet view. */
export const ATTENTION_JOB_STATES = new Set([
  "degraded",
  "failed",
  "rollout_failed",
  "queued",
]);

/** Execution states that count as recent errors. */
export const ERROR_EXECUTION_STATES = ["failed", "degraded", "lost"] as const;

export function jobUri(workspaceId: string, jobId: string): string {
  return `expanso://workspaces/${encodeURIComponent(workspaceId)}/jobs/${encodeURIComponent(jobId)}`;
}

export function nodeUri(workspaceId: string, nodeId: string): string {
  return `expanso://workspaces/${encodeURIComponent(workspaceId)}/nodes/${encodeURIComponent(nodeId)}`;
}

export function countBy<T>(items: readonly T[], key: (item: T) => string) {
  const counts = new Map<string, number>();

  for (const item of items) {
    const value = key(item);

    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  return Object.fromEntries(counts);
}
