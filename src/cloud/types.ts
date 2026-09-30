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
      created_at: text,
      last_heartbeat: text,
      message: text,
      resource_usage: z
        .object({
          cpu_percent: z.number().optional(),
          memory_percent: z.number().optional(),
          memory_used_bytes: z.number().optional(),
          memory_capacity_bytes: z.number().optional(),
          disk_percent: z.number().optional(),
          disk_used_bytes: z.number().optional(),
          disk_capacity_bytes: z.number().optional(),
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
  resource_stats: z.lazy(() => NodeResourceStatsSchema).optional(),
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

// Writes and dashboards. Specs are kept as plain JSON: the plugin sends back
// exactly what it read or was given, and never drops fields it does not
// model.

export const JsonSchema = z.json();

export type JsonValue = z.infer<typeof JsonSchema>;

export type JsonObject = { [key: string]: JsonValue };

/** A JSON object whose fields may be left unset, as request bodies are. */
export type JsonFields = { [key: string]: JsonValue | undefined };

export const JobSpecSchema = z.record(z.string(), JsonSchema);

export type JobSpec = JsonObject;

export function isJsonObject(
  value: JsonValue | undefined,
): value is JsonObject {
  return value instanceof Object && !Array.isArray(value);
}

export function isJsonArray(
  value: JsonValue | undefined,
): value is JsonValue[] {
  return Array.isArray(value);
}

const TextSchema = z.string();

/** The value as text when it is a JSON string. */
export function jsonText(value: JsonValue | undefined): string | undefined {
  const parsed = TextSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

const warnings = z.array(z.string()).optional();

export const RawJobEnvelopeSchema = z.object({
  job: z
    .object({
      id: text,
      status: JobSchema.shape.status,
    })
    .optional(),
});

/** The spec alone, read without dropping nulls. */
export const JobSpecEnvelopeSchema = z.object({
  job: z.object({ spec: JobSpecSchema.nullish() }).nullish(),
});

export const PutJobResponseSchema = z.object({
  job: JobSchema.optional(),
  created: z.boolean().optional(),
  warnings,
});

/** PUT /jobs/-/diff answers with capitalized keys. */
export const JobDiffResponseSchema = z
  .object({
    Diff: text,
    Warnings: warnings,
    diff: text,
    warnings,
  })
  .transform((body) => ({
    diff: body.Diff ?? body.diff ?? "",
    warnings: body.Warnings ?? body.warnings ?? [],
  }));

export const JobIdResponseSchema = z.object({ job_id: text });

export const RerunResponseSchema = z.object({
  job_id: text,
  version: z.number().optional(),
  warnings,
});

export const RollbackResponseSchema = z.object({
  job_id: text,
  rollback_to_version: z.number().optional(),
  to_version: z.number().optional(),
  warnings,
});

export const NodeDeleteResponseSchema = z.object({
  node_id: text,
  message: text,
});

export const JobVersionSchema = z.object({
  version: z.number().optional(),
  spec: JobSpecSchema.optional(),
  status: JobSchema.shape.status,
});

export const JobVersionPageSchema = pageOf(
  JobVersionSchema.omit({ spec: true }),
);

/** Version specs alone, read without dropping nulls. */
export const JobVersionSpecsSchema = z.object({
  items: z
    .array(
      z.object({
        version: z.number().nullish(),
        spec: JobSpecSchema.nullish(),
      }),
    )
    .nullish(),
});

export const JobVersionDiffSchema = z.object({
  job_id: text,
  from_version: z.number().optional(),
  to_version: z.number().optional(),
  diff: text,
});

const minMax = z
  .object({
    avg_percent: z.number().optional(),
    max_percent: z.number().optional(),
    min_percent: z.number().optional(),
  })
  .optional();

export const NodeResourceStatsSchema = z.object({
  cpu: minMax,
  memory: minMax,
  disk: minMax,
});

export const ServiceStatusSchema = z.object({
  runtime: z
    .object({
      version: text,
      status: text,
      start_time: text,
      uptime_seconds: z.number().optional(),
    })
    .optional(),
  nodes: z
    .object({
      total: z.number().optional(),
      by_connection: z.record(z.string(), z.number()).optional(),
      latest_join_time: text,
    })
    .optional(),
  jobs: z
    .object({
      total: z.number().optional(),
      by_state: z.record(z.string(), z.number()).optional(),
      latest_created_at: text,
    })
    .optional(),
  executions: z
    .object({
      total: z.number().optional(),
      by_state: z.record(z.string(), z.number()).optional(),
    })
    .optional(),
  evaluations: z
    .object({
      ready: z.number().optional(),
      inflight: z.number().optional(),
      pending: z.number().optional(),
      waiting: z.number().optional(),
    })
    .optional(),
  collected_at: text,
});

/** Prometheus query_range matrix: one series per node. */
export const QueryRangeSchema = z.object({
  data: z
    .object({
      result: z
        .array(
          z.object({
            metric: z.record(z.string(), z.string()).optional(),
            values: z.array(z.tuple([z.number(), z.string()])).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export type ServiceStatus = z.infer<typeof ServiceStatusSchema>;

export type QueryRange = z.infer<typeof QueryRangeSchema>;

export type JobVersion = z.infer<typeof JobVersionSchema>;

export type NodeMetric =
  | "process_cpu_utilization_ratio"
  | "process_memory_usage_bytes"
  | "process_disk_usage_bytes";
