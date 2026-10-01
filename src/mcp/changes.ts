import { CloudApiError, type WorkspaceClient } from "../cloud/client.js";
import {
  jsonText,
  type ExecutionState,
  type JobSpec,
  type JsonFields,
  type JsonObject,
  type JsonValue,
} from "../cloud/types.js";
import { collectAll } from "./inventory.js";
import {
  canonicalJson,
  fingerprint,
  PlanError,
  type SignedPlan,
} from "./confirm.js";
import type { ChangePreview, ChangeResult } from "./contracts.js";
import { lineDiff } from "./diff.js";
import {
  parseSpecText,
  redactForDiff,
  redactSpec,
  restoreRedacted,
  selectorOf,
  specKind,
  specName,
  specYaml,
  SpecError,
} from "./spec.js";
import { executionView, jobView, nodeView } from "./views.js";

// What each change does, grounded in the orchestrator API:
//   deploy_job      PUT /jobs (create, or update by name) or PUT /jobs/{id}
//   stop_job        POST /jobs/{id}/stop
//   rerun_job       PUT /jobs/{id}/rerun
//   delete_job      DELETE /jobs/{id}
//   rollback_job    POST /jobs/{id}/rollback
//   pause_rollout   POST /jobs/{id}/rollout/pause
//   resume_rollout  POST /jobs/{id}/rollout/resume
//   delete_node     DELETE /nodes/{id}
// Previews use PUT /jobs with dry_run (full validation, rolled back), the
// job's current spec and versions, and the node list filtered by selector.

/** Write tools, in the order they are registered. */
export const WRITE_ACTIONS = [
  "deploy_job",
  "stop_job",
  "rerun_job",
  "delete_job",
  "rollback_job",
  "pause_rollout",
  "resume_rollout",
  "delete_node",
] as const;

export type WriteAction = (typeof WRITE_ACTIONS)[number];

/** Plan actions: every write, plus deploy_pipeline, which builds a spec. */
export const PLAN_ACTIONS = [...WRITE_ACTIONS, "deploy_pipeline"] as const;

export type PlanAction = (typeof PLAN_ACTIONS)[number];

export const DESTRUCTIVE: Record<WriteAction, boolean> = {
  deploy_job: true,
  stop_job: true,
  rerun_job: false,
  delete_job: true,
  rollback_job: true,
  pause_rollout: false,
  resume_rollout: false,
  delete_node: true,
};

/** Target node names shown in a preview; the count covers the rest. */
const SHOWN_NODES = 20;

/** Jobs read while looking for one by exact name, across every page. */
const NAME_LOOKUP_CAP = 20_000;

/** Execution states that are still doing work on a node. */
const ACTIVE_EXECUTION_STATES: ExecutionState[] = [
  "pending",
  "starting",
  "validating",
  "running",
  "degraded",
  "stopping",
];

/** Job states delete accepts without force. */
const DELETABLE_JOB_STATES = new Set(["stopped", "completed", "failed"]);

type ChangeClient = Pick<
  WorkspaceClient,
  | "getJob"
  | "getJobSpec"
  | "getNode"
  | "listJobs"
  | "listNodes"
  | "listExecutions"
  | "jobExecutions"
  | "jobVersions"
  | "putJob"
  | "putJobById"
  | "stopJob"
  | "rerunJob"
  | "deleteJob"
  | "rollbackJob"
  | "pauseRollout"
  | "resumeRollout"
  | "deleteNode"
>;

export interface ChangeContext {
  client: ChangeClient;
  workspaceId: string;
  sign: (plan: SignedPlan) => Promise<string>;
  verify: (token: string, plan: SignedPlan) => Promise<void>;
}

export interface SelectorInput {
  matchLabels?: Record<string, string>;
  matchIds?: string[];
  matchExpressions?: string[];
}

export interface PlanRequest {
  action: PlanAction;
  jobId?: string;
  nodeId?: string;
  /** deploy_job: a complete job spec as YAML or JSON. */
  spec?: string;
  /** deploy_pipeline: the pipeline's name. */
  name?: string;
  /** deploy_pipeline: the pipeline config (inputs, processors, outputs) as YAML. */
  config?: string;
  description?: string;
  selector?: SelectorInput;
  version?: number;
  force?: boolean;
  reason?: string;
}

/** Arguments a write tool takes: the preview's fields plus confirmToken. */
export type WriteArguments = JsonFields;

// ---------------------------------------------------------------- preview

export async function previewChange(
  ctx: ChangeContext,
  request: PlanRequest,
): Promise<ChangePreview> {
  switch (request.action) {
    case "deploy_job":
      return previewDeploy(ctx, required(request.spec, "spec"), request.jobId);
    case "deploy_pipeline":
      return previewDeploy(
        ctx,
        await pipelineSpecText(ctx, request),
        request.jobId,
      );
    case "stop_job":
    case "rerun_job":
    case "pause_rollout":
    case "resume_rollout":
      return previewJobAction(ctx, request.action, request);
    case "delete_job":
      return previewDeleteJob(ctx, request);
    case "rollback_job":
      return previewRollback(ctx, request);
    case "delete_node":
      return previewDeleteNode(ctx, request);
  }
}

async function previewDeploy(
  ctx: ChangeContext,
  specText: string,
  jobId?: string,
): Promise<ChangePreview> {
  const given = parseSpecText(specText);
  const name = specName(given);

  if (!name && !jobId) {
    throw new SpecError("The spec needs a name.");
  }

  const existing = jobId
    ? await ctx.client.getJobSpec(jobId)
    : await findJobByName(ctx.client, name!);

  const merged = restoreRedacted(given, existing?.spec);
  const jobName = specName(merged) ?? existing?.id ?? "";

  const dryRun = await explain(
    existing
      ? ctx.client.putJobById(existing.id, merged, { dryRun: true })
      : ctx.client.putJob(merged, { dryRun: true }),
    "The workspace rejected this spec",
  );

  const operation = existing ? "update" : "create";

  const diff = lineDiff(
    existing ? specYaml(redactForDiff(existing.spec)) : "",
    specYaml(redactForDiff(merged)),
  );

  const targets = await resolveTargets(ctx.client, merged);
  const kind = specKind(merged) ?? "job";

  const summary = `${operation === "create" ? "Create" : "Update"} ${kind} "${jobName}"${existing?.version !== undefined ? ` (now version ${existing.version})` : ""} on up to ${targets.count} connected nodes matching ${targets.selector}: ${diff.added} lines added, ${diff.removed} removed.`;

  const args = {
    workspaceId: ctx.workspaceId,
    summary,
    operation,
    jobName,
    jobId: existing?.id,
    targetNodes: targets.shown,
    diff: diff.text,
    spec: specText,
    baseFingerprint: existing
      ? await fingerprint(canonicalJson(existing.spec))
      : undefined,
  };

  return preview(ctx, "deploy_job", args, {
    summary,
    targetName: jobName,
    targets,
    diff,
    warnings: [
      ...(dryRun.warnings ?? []),
      ...(operation === "update"
        ? ["Running executions restart with the new spec as a rollout."]
        : []),
    ],
  });
}

/** Builds a pipeline job spec the way Expanso Cloud's pipeline editor does. */
async function pipelineSpecText(
  ctx: ChangeContext,
  request: PlanRequest,
): Promise<string> {
  let spec: JobSpec;

  if (request.jobId) {
    // Edit: start from the current spec, with credentials left as placeholders.
    const current = await ctx.client.getJobSpec(request.jobId);

    spec = redactSpec(current.spec);
  } else {
    if (!request.name) {
      throw new SpecError("A new pipeline needs a name.");
    }

    if (!request.config) {
      throw new SpecError("A new pipeline needs its config.");
    }

    spec = { name: request.name, type: "pipeline" };
  }

  if (request.name) spec.name = request.name;

  if (request.description !== undefined) spec.description = request.description;

  if (request.config !== undefined) {
    spec.config = parseSpecText(request.config, "The pipeline config");
  }

  if (request.selector) spec.selector = selectorSpec(request.selector);

  return specYaml(spec);
}

function selectorSpec(input: SelectorInput): JobSpec {
  const selector: JobSpec = {};

  if (input.matchIds?.length) selector.match_ids = input.matchIds;

  if (input.matchLabels && Object.keys(input.matchLabels).length > 0) {
    selector.match_labels = input.matchLabels;
  }

  if (input.matchExpressions?.length) {
    selector.match_expressions = input.matchExpressions;
  }

  return selector;
}

async function previewJobAction(
  ctx: ChangeContext,
  action: "stop_job" | "rerun_job" | "pause_rollout" | "resume_rollout",
  request: PlanRequest,
): Promise<ChangePreview> {
  const jobId = required(request.jobId, "jobId");
  const job = jobView(await ctx.client.getJob(jobId));
  const name = job.name ?? job.id;
  const targets = await activeNodes(ctx.client, jobId);
  const warnings: string[] = [];

  if (
    (action === "pause_rollout" && job.state !== "deploying") ||
    (action === "resume_rollout" && job.state !== "rollout_paused")
  ) {
    warnings.push(
      `The job is ${job.state}; the workspace refuses this unless a rollout is ${action === "pause_rollout" ? "in progress" : "paused"}.`,
    );
  }

  const summary = {
    stop_job: `Stop job "${name}" (${job.state}). Its executions on ${targets.count} nodes stop. Deploy it again to restart it.`,
    rerun_job: `Restart job "${name}" with its current spec (version ${job.version ?? "?"}) as a new rollout on ${targets.count} nodes.`,
    pause_rollout: `Pause the rollout of job "${name}" (${job.state}). Nodes already updated keep the new version.`,
    resume_rollout: `Resume the paused rollout of job "${name}".`,
  }[action];

  return preview(
    ctx,
    action,
    {
      workspaceId: ctx.workspaceId,
      summary,
      jobId,
      jobName: name,
      targetNodes: targets.shown,
      reason: request.reason,
    },
    { summary, targetName: name, targets, warnings },
  );
}

async function previewDeleteJob(
  ctx: ChangeContext,
  request: PlanRequest,
): Promise<ChangePreview> {
  const jobId = required(request.jobId, "jobId");
  const job = jobView(await ctx.client.getJob(jobId));
  const name = job.name ?? job.id;
  const force = request.force === true;

  if (!DELETABLE_JOB_STATES.has(job.state) && !force) {
    throw new PlanError(
      `Job "${name}" is ${job.state}. Stop it first, or preview delete_job with force to stop and delete it in one step.`,
    );
  }

  const targets = await activeNodes(ctx.client, jobId);

  const summary = `Delete job "${name}" (${job.state})${force && targets.count > 0 ? `, stopping its executions on ${targets.count} nodes` : ""}. This cannot be undone from Expanso Fleet.`;

  return preview(
    ctx,
    "delete_job",
    {
      workspaceId: ctx.workspaceId,
      summary,
      jobId,
      jobName: name,
      targetNodes: targets.shown,
      force: force || undefined,
      reason: request.reason,
    },
    { summary, targetName: name, targets, warnings: [] },
  );
}

async function previewRollback(
  ctx: ChangeContext,
  request: PlanRequest,
): Promise<ChangePreview> {
  const jobId = required(request.jobId, "jobId");

  const [current, versions] = await Promise.all([
    ctx.client.getJobSpec(jobId),
    ctx.client.jobVersions(jobId),
  ]);

  const known = (versions.items ?? []).filter(
    (item) => item.version !== undefined && item.spec,
  );

  const currentVersion = current.version;

  const target =
    request.version !== undefined
      ? known.find((item) => item.version === request.version)
      : known
          .filter(
            (item) =>
              currentVersion === undefined || item.version! < currentVersion,
          )
          .sort((a, b) => b.version! - a.version!)[0];

  if (!target?.spec || target.version === undefined) {
    throw new PlanError(
      request.version !== undefined
        ? `Version ${request.version} of this job was not found.`
        : "This job has no earlier version to roll back to.",
    );
  }

  if (target.version === currentVersion) {
    throw new PlanError(`The job is already at version ${target.version}.`);
  }

  const dryRun = await explain(
    ctx.client.rollbackJob(jobId, { version: target.version, dryRun: true }),
    "The workspace refused this rollback",
  );

  const name = specName(current.spec) ?? jobId;

  const diff = lineDiff(
    specYaml(redactForDiff(current.spec)),
    specYaml(redactForDiff(target.spec)),
  );

  const targets = await resolveTargets(ctx.client, target.spec);

  const summary = `Roll back job "${name}" from version ${currentVersion ?? "?"} to version ${target.version} on up to ${targets.count} connected nodes: ${diff.added} lines added, ${diff.removed} removed.`;

  return preview(
    ctx,
    "rollback_job",
    {
      workspaceId: ctx.workspaceId,
      summary,
      jobId,
      jobName: name,
      version: target.version,
      targetNodes: targets.shown,
      diff: diff.text,
      baseFingerprint: await fingerprint(canonicalJson(current.spec)),
      reason: request.reason,
    },
    {
      summary,
      targetName: name,
      targets,
      diff,
      warnings: dryRun.warnings ?? [],
    },
  );
}

async function previewDeleteNode(
  ctx: ChangeContext,
  request: PlanRequest,
): Promise<ChangePreview> {
  const nodeId = required(request.nodeId, "nodeId");
  const node = nodeView(await ctx.client.getNode(nodeId));
  const name = node.name ?? node.id;
  const force = request.force === true;

  if (node.online && !force) {
    throw new PlanError(
      `Node "${name}" is connected. Delete only lost or disconnected nodes, or preview delete_node with force to remove a connected one.`,
    );
  }

  const running = await ctx.client.listExecutions({
    nodeIds: [nodeId],
    states: ACTIVE_EXECUTION_STATES,
    limit: 100,
  });

  const jobs = [
    ...new Set(
      (running.items ?? [])
        .map((execution) => executionView(execution).jobId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  const summary = `Delete node "${name}" (${node.connectionState})${jobs.length > 0 ? `; ${jobs.length} jobs have executions on it` : ""}. The node must enroll again to rejoin.`;

  return preview(
    ctx,
    "delete_node",
    {
      workspaceId: ctx.workspaceId,
      summary,
      nodeId,
      nodeName: name,
      affectedJobs: jobs.slice(0, SHOWN_NODES),
      force: force || undefined,
      reason: request.reason,
    },
    {
      summary,
      targetName: name,
      targets: { count: 1, shown: [name], more: false },
      warnings: [],
    },
  );
}

interface PreviewParts {
  summary: string;
  targetName: string;
  targets: Targets;
  diff?: ReturnType<typeof lineDiff>;
  warnings: string[];
}

async function preview(
  ctx: ChangeContext,
  action: WriteAction,
  args: JsonFields,
  parts: PreviewParts,
): Promise<ChangePreview> {
  const clean = withoutUndefined(args);
  const confirmToken = await ctx.sign(signedPlan(action, clean));

  return {
    action,
    summary: parts.summary,
    destructive: DESTRUCTIVE[action],
    workspaceId: ctx.workspaceId,
    targetName: parts.targetName,
    targetNodes: {
      count: parts.targets.count,
      names: parts.targets.shown,
      more: parts.targets.more,
      selector: parts.targets.selector,
    },
    diff: parts.diff,
    warnings: parts.warnings,
    next: { tool: action, arguments: { ...clean, confirmToken } },
  };
}

function signedPlan(action: WriteAction, args: JsonObject): SignedPlan {
  const { workspaceId, ...rest } = args;

  return { action, workspaceId: jsonText(workspaceId) ?? "", preview: rest };
}

// ------------------------------------------------------------------ apply

/**
 * Runs a confirmed change. The arguments must be exactly what the preview
 * returned in `next.arguments`; anything else is refused before Expanso is
 * called.
 */
export async function applyChange(
  ctx: ChangeContext,
  action: WriteAction,
  input: WriteArguments,
): Promise<ChangeResult> {
  const { confirmToken, ...args } = input;

  await ctx.verify(
    jsonText(confirmToken) ?? "",
    signedPlan(
      action,
      withoutUndefined({ ...args, workspaceId: ctx.workspaceId }),
    ),
  );

  const summary = jsonText(args.summary) ?? "";
  const jobId = jsonText(args.jobId);
  const nodeId = jsonText(args.nodeId);
  const reason = jsonText(args.reason);
  const force = args.force === true || undefined;

  if (action === "deploy_job") {
    const given = parseSpecText(jsonText(args.spec) ?? "");

    const result = jobId
      ? await deployOver(ctx.client, jobId, given, args.baseFingerprint)
      : await createJob(ctx.client, given);

    const job = jobView(result.job ?? {});

    return done(action, summary, {
      jobId: job.id || jobId,
      version: job.version,
      warnings: result.warnings,
    });
  }

  if (action === "delete_node") {
    await ctx.client.deleteNode(required(nodeId, "nodeId"), { force, reason });

    return done(action, summary, { nodeId });
  }

  const id = required(jobId, "jobId");

  if (action === "rerun_job") {
    const result = await ctx.client.rerunJob(id);

    return done(action, summary, {
      jobId,
      version: result.version,
      warnings: result.warnings,
    });
  }

  if (action === "rollback_job") {
    const current = await ctx.client.getJobSpec(id);

    await assertUnchanged(current.spec, args.baseFingerprint);

    const result = await ctx.client.rollbackJob(id, {
      version: Number(args.version),
      reason,
    });

    return done(action, summary, {
      jobId,
      version: result.to_version ?? result.rollback_to_version,
      warnings: result.warnings,
    });
  }

  const simple = {
    stop_job: () => ctx.client.stopJob(id, reason),
    delete_job: () => ctx.client.deleteJob(id, { force, reason }),
    pause_rollout: () => ctx.client.pauseRollout(id, reason),
    resume_rollout: () => ctx.client.resumeRollout(id, reason),
  } satisfies Record<string, () => Promise<{ job_id?: string }>>;

  await simple[action]();

  return done(action, summary, { jobId });
}

/** Creates a job after checking no job of that name appeared since the preview. */
async function createJob(client: ChangeClient, given: JobSpec) {
  const name = specName(given);

  if (name && (await findJobByName(client, name))) {
    throw new PlanError(
      `A job named ${name} now exists. Preview the change again.`,
    );
  }

  return client.putJob(restoreRedacted(given, undefined));
}

/** Updates a job by ID after checking it still matches the preview. */
async function deployOver(
  client: ChangeClient,
  jobId: string,
  given: JobSpec,
  baseFingerprint: JsonValue | undefined,
) {
  const current = await client.getJobSpec(jobId);

  await assertUnchanged(current.spec, baseFingerprint);

  return client.putJobById(jobId, restoreRedacted(given, current.spec));
}

async function assertUnchanged(spec: JobSpec, expected: JsonValue | undefined) {
  const actual = await fingerprint(canonicalJson(spec));

  if (actual !== jsonText(expected)) {
    throw new PlanError(
      "The job changed after this preview was made. Preview the change again.",
    );
  }
}

function done(
  action: WriteAction,
  summary: string,
  extra: {
    jobId?: string;
    nodeId?: string;
    version?: number;
    warnings?: string[];
  },
): ChangeResult {
  return {
    action,
    ok: true,
    summary: `Done. ${summary}`,
    jobId: extra.jobId,
    nodeId: extra.nodeId,
    version: extra.version,
    warnings: extra.warnings ?? [],
  };
}

// ---------------------------------------------------------------- helpers

interface Targets {
  count: number;
  shown: string[];
  more: boolean;
  selector?: string;
}

/**
 * The nodes a spec would be placed on: nodes matching its selector (ids,
 * labels, and expressions ANDed, as the orchestrator does) that are
 * connected, since only connected nodes receive executions. The scheduler
 * can still pass over a matching node that lacks a capability, so this is
 * an upper bound.
 */
async function resolveTargets(
  client: ChangeClient,
  spec: JobSpec,
): Promise<Targets> {
  const selector = selectorOf(spec);

  const listed = await collectAll(
    (page) => client.listNodes({ labels: selector.labels, ...page }),
    nodeView,
  );

  const ids = new Set(selector.matchIds);

  const matching = listed.items.filter(
    (node) => node.online && (ids.size === 0 || ids.has(node.id)),
  );

  return {
    count: matching.length,
    shown: matching.slice(0, SHOWN_NODES).map((node) => node.name ?? node.id),
    more: matching.length > SHOWN_NODES || listed.nextToken !== undefined,
    selector: selector.text,
  };
}

/** Nodes where a job still has executions doing work. */
async function activeNodes(
  client: ChangeClient,
  jobId: string,
): Promise<Targets> {
  const page = await client.jobExecutions(jobId, {
    states: ACTIVE_EXECUTION_STATES,
    limit: 1000,
  });

  const nodes = [
    ...new Set(
      (page.items ?? [])
        .map((execution) => execution.node_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  return {
    count: nodes.length,
    shown: nodes.slice(0, SHOWN_NODES),
    more: nodes.length > SHOWN_NODES || Boolean(page.next_token),
  };
}

async function findJobByName(
  client: ChangeClient,
  name: string,
): Promise<{ id: string; spec: JobSpec; version?: number } | undefined> {
  const listed = await collectAll(
    (page) => client.listJobs({ prefix: name, ...page }),
    (job) => job,
    NAME_LOOKUP_CAP,
  );

  if (listed.nextToken) {
    throw new PlanError(
      `More than ${NAME_LOOKUP_CAP} jobs have names starting with "${name}". Give the jobId of the job to update.`,
    );
  }

  const match = listed.items.find(
    (job) =>
      job.spec?.name === name && job.status?.state?.state_type !== "deleted",
  );

  return match?.id ? client.getJobSpec(match.id) : undefined;
}

/** Turns a refusal into a preview error that says what Expanso said. */
async function explain<T>(work: Promise<T>, what: string): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof CloudApiError && error.status < 500) {
      throw new PlanError(`${what}. ${error.message}`);
    }

    throw error;
  }
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === "") {
    throw new PlanError(`This change needs ${name}.`);
  }

  return value;
}

function withoutUndefined(record: JsonFields): JsonObject {
  const clean: JsonObject = {};

  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) clean[key] = value;
  }

  return clean;
}
