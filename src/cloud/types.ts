import { z } from "zod";

// The subset of the Expanso orchestrator API (v1) this plugin reads. Field
// names match the orchestrator's JSON. Every field is optional because the API
// omits empty values, and unknown fields are dropped at parse time.

const text = z.string().optional();

const stringMap = z.record(z.string(), z.string()).optional();

const stateOf = z
  .object({ state_type: text, message: text, details: stringMap })
  .optional();

export const NodeSchema = z.object({
  id: text,
  spec: z
    .object({
      name: text,
      hostname: text,
      os: text,
      arch: text,
      agent_version: text,
      labels: stringMap,
    })
    .optional(),
  status: z
    .object({
      connection_state: text,
      connected_since: text,
      disconnected_since: text,
      last_heartbeat: text,
      message: text,
      resource_usage: z
        .object({
          cpu_percent: z.number().optional(),
          memory_percent: z.number().optional(),
          disk_percent: z.number().optional(),
        })
        .optional(),
      updated_at: text,
    })
    .optional(),
});

export const JobSchema = z.object({
  id: text,
  spec: z
    .object({
      name: text,
      type: text,
      description: text,
      namespace: text,
      labels: stringMap,
    })
    .optional(),
  status: z
    .object({
      state: stateOf,
      version: z.number().optional(),
      revision: z.number().optional(),
      created_at: text,
      updated_at: text,
    })
    .optional(),
});

export const ExecutionSchema = z.object({
  id: text,
  job_id: text,
  job_type: text,
  job_version: z.number().optional(),
  node_id: text,
  namespace: text,
  status: z
    .object({
      desired_state: stateOf,
      observed_state: stateOf,
      details: stringMap,
      created_at: text,
      updated_at: text,
    })
    .optional(),
});

export const HistoryEventSchema = z.object({
  seq_num: z.number().optional(),
  timestamp: text,
  message: text,
  job_id: text,
  execution_id: text,
  job_version: z.number().optional(),
  details: stringMap,
});

export const NodeStatsSchema = z.object({
  total_nodes: z.number().optional(),
  nodes_by_connection_state: z.record(z.string(), z.number()).optional(),
  nodes_by_os: z.record(z.string(), z.number()).optional(),
  nodes_by_arch: z.record(z.string(), z.number()).optional(),
});

export const pageOf = <Item extends z.ZodType>(item: Item) =>
  z.object({ items: z.array(item).optional(), next_token: text });

export const NodePageSchema = pageOf(NodeSchema);

export const JobPageSchema = pageOf(JobSchema);

export const ExecutionPageSchema = pageOf(ExecutionSchema);

export const HistoryPageSchema = pageOf(HistoryEventSchema);

export const NodeEnvelopeSchema = z.object({ node: NodeSchema.optional() });

export const JobEnvelopeSchema = z.object({ job: JobSchema.optional() });

export const ExecutionEnvelopeSchema = z.object({
  execution: ExecutionSchema.optional(),
});

export const ErrorBodySchema = z.object({ message: text });

export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().positive().optional(),
});

export const TokenClaimsSchema = z.object({
  sub: z.string().min(1),
  organizationId: z.string().min(1),
  email: text,
  networkId: text,
});

export type Node = z.infer<typeof NodeSchema>;

export type Job = z.infer<typeof JobSchema>;

export type Execution = z.infer<typeof ExecutionSchema>;

export type HistoryEvent = z.infer<typeof HistoryEventSchema>;

export type NodeStats = z.infer<typeof NodeStatsSchema>;

export interface Page<Item> {
  items?: Item[];
  next_token?: string;
}

export type ExecutionState =
  | "pending"
  | "starting"
  | "validating"
  | "running"
  | "degraded"
  | "completed"
  | "failed"
  | "lost"
  | "stopping"
  | "stopped";
