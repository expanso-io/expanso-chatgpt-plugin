import { describe, expect, it } from "vitest";
import { WorkspaceClient } from "../src/cloud/client.js";
import type { JsonObject, JsonValue } from "../src/cloud/types.js";
import {
  applyChange,
  previewChange,
  type ChangeContext,
  type PlanRequest,
} from "../src/mcp/changes.js";
import { signPlan, verifyPlan } from "../src/mcp/confirm.js";
import type { ChangePreview } from "../src/mcp/contracts.js";
import {
  fail,
  fakeFetch,
  reply,
  TEST_ENCRYPTION_KEY,
  type RecordedRequest,
  type Route,
} from "./helpers.js";

const ENDPOINT = "ws1.us1.cloud.expanso.io:9010";

const API = `https://${ENDPOINT}/api/v1`;

const ACCOUNT = "acct-fixture";

const SECRET = "hunter2-fixture";

const NODES = {
  items: [
    {
      id: "node-a",
      spec: { name: "edge-a", labels: { region: "us" } },
      status: { connection_state: "connected" },
    },
    {
      id: "node-b",
      spec: { name: "edge-b", labels: { region: "us" } },
      status: { connection_state: "disconnected" },
    },
    {
      id: "node-c",
      spec: { name: "edge-c", labels: { region: "us" } },
      status: { connection_state: "connected" },
    },
  ],
};

const CURRENT_SPEC = {
  name: "sensor-sink",
  type: "pipeline",
  selector: { match_labels: { region: "us" } },
  config: {
    input: { http_server: { path: "/ingest" } },
    output: { sql: { host: "db-1", password: SECRET, options: null } },
  },
};

function job(state: string, version = 3): JsonObject {
  return {
    job: {
      id: "job-1",
      spec: CURRENT_SPEC,
      status: { state: { state_type: state }, version },
    },
  };
}

const EXECUTIONS = {
  items: [
    { id: "ex-1", job_id: "job-1", node_id: "node-a" },
    { id: "ex-2", job_id: "job-1", node_id: "node-c" },
  ],
};

function setup(routes: Record<string, Route>, account = ACCOUNT) {
  const { fetch, requests } = fakeFetch(routes);

  const ctx: ChangeContext = {
    client: new WorkspaceClient(ENDPOINT, "token-fixture", fetch),
    workspaceId: "ws1",
    sign: (plan) => signPlan(TEST_ENCRYPTION_KEY, account, plan),
    verify: (token, plan) =>
      verifyPlan(TEST_ENCRYPTION_KEY, ACCOUNT, token, plan),
  };

  const writes = () => requests.filter((request) => request.method !== "GET");

  return { ctx, requests, writes };
}

function bodyOf(request: RecordedRequest | undefined): JsonValue {
  return JSON.parse(request?.body ?? "null");
}

async function previewAndApply(ctx: ChangeContext, request: PlanRequest) {
  const preview = await previewChange(ctx, request);

  const result = await applyChange(
    ctx,
    toolOf(preview),
    preview.next.arguments,
  );

  return { preview, result };
}

function toolOf(preview: ChangePreview) {
  const tool = preview.next.tool;

  if (
    tool !== "deploy_job" &&
    tool !== "stop_job" &&
    tool !== "rerun_job" &&
    tool !== "delete_job" &&
    tool !== "rollback_job" &&
    tool !== "pause_rollout" &&
    tool !== "resume_rollout" &&
    tool !== "delete_node"
  ) {
    throw new Error(`unexpected tool ${tool}`);
  }

  return tool;
}

const NEW_SPEC = `name: edge-logs
type: pipeline
selector:
  match_labels:
    region: us
config:
  input:
    file: { paths: [/var/log/app.log] }
  output:
    stdout: {}
`;

describe("deploy_job", () => {
  it("previews a new job with a dry run, target nodes, and a diff, then creates it", async () => {
    const { ctx, requests, writes } = setup({
      [`GET ${API}/jobs`]: reply({ items: [] }),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs`]: reply({
        job: { id: "job-new", status: { version: 1 } },
        created: true,
        warnings: ["No rollout strategy set; using immediate."],
      }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      spec: NEW_SPEC,
    });

    const dryRun = writes()[0];

    expect(dryRun.method).toBe("PUT");
    expect(dryRun.url.pathname).toBe("/api/v1/jobs");
    expect(bodyOf(dryRun)).toMatchObject({
      dry_run: true,
      spec: { name: "edge-logs", type: "pipeline" },
    });

    const nodeList = requests.find(
      (request) => request.url.pathname === "/api/v1/nodes",
    );

    expect(nodeList?.url.searchParams.getAll("labels")).toEqual(["region=us"]);

    expect(preview).toMatchObject({
      action: "deploy_job",
      destructive: true,
      targetName: "edge-logs",
      targetNodes: {
        count: 2,
        names: ["edge-a", "edge-c"],
        selector: "region=us",
      },
      warnings: ["No rollout strategy set; using immediate."],
      next: { tool: "deploy_job" },
    });

    expect(preview.summary).toContain('Create pipeline "edge-logs"');
    expect(preview.diff?.removed).toBe(0);
    expect(preview.diff?.text).toContain("+ name: edge-logs");
    expect(preview.next.arguments).toMatchObject({
      operation: "create",
      jobName: "edge-logs",
      targetNodes: ["edge-a", "edge-c"],
    });

    const result = await applyChange(ctx, "deploy_job", preview.next.arguments);

    const created = writes()[1];

    expect(bodyOf(created)).not.toHaveProperty("dry_run");
    expect(bodyOf(created)).toMatchObject({ spec: { name: "edge-logs" } });
    expect(result).toMatchObject({
      ok: true,
      jobId: "job-new",
      version: 1,
      warnings: ["No rollout strategy set; using immediate."],
    });
  });

  it("keeps credentials it never showed when updating a job", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs/job-1`]: reply({
        job: { id: "job-1", status: { version: 4 } },
      }),
    });

    const spec = `name: sensor-sink
type: pipeline
selector:
  match_labels:
    region: us
config:
  input:
    http_server: { path: /ingest-v2 }
  output:
    sql: { host: db-1, password: "[redacted]", options: null }
`;

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      jobId: "job-1",
      spec,
    });

    // The dry run and the deploy carry the real value; nothing shown does.
    expect(writes()[0].body).toContain(SECRET);
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(preview.summary).toContain('Update pipeline "sensor-sink"');
    expect(preview.diff?.text).toContain("- ");
    expect(preview.diff?.text).toContain("/ingest-v2");
    expect(preview.next.arguments).toMatchObject({
      operation: "update",
      jobId: "job-1",
    });

    await applyChange(ctx, "deploy_job", preview.next.arguments);

    const deployed = writes()[1];

    expect(deployed.url.pathname).toBe("/api/v1/jobs/job-1");
    expect(bodyOf(deployed)).toMatchObject({
      spec: {
        config: { output: { sql: { host: "db-1", password: SECRET } } },
      },
    });

    // Nulls in the current spec survive the round trip.
    expect(deployed.body).toContain('"options":null');
    expect(bodyOf(deployed)).not.toHaveProperty("dry_run");
  });

  it("refuses to preview a kept credential sent to a changed host", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
    });

    const spec = JSON.stringify({
      ...CURRENT_SPEC,
      config: {
        ...CURRENT_SPEC.config,
        output: { sql: { host: "db-attacker", password: "[redacted]" } },
      },
    });

    await expect(
      previewChange(ctx, { action: "deploy_job", jobId: "job-1", spec }),
    ).rejects.toThrow(
      /config\.output\.sql holds a \[redacted\] value, but other fields in config\.output\.sql changed/,
    );

    expect(writes()).toHaveLength(0);
  });

  it("shows that a credential changed without showing either value", async () => {
    const { ctx } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs/job-1`]: reply({ job: { id: "job-1" } }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      jobId: "job-1",
      spec: JSON.stringify({
        ...CURRENT_SPEC,
        config: {
          ...CURRENT_SPEC.config,
          output: { sql: { host: "db-1", password: "new-secret-value" } },
        },
      }),
    });

    expect(preview.diff?.text).toMatch(
      /- .*password: "?\[redacted [0-9a-f]{4}\]/,
    );
    expect(preview.diff?.text).toMatch(
      /\+ .*password: "?\[redacted [0-9a-f]{4}\]/,
    );
    expect(JSON.stringify(preview.diff)).not.toContain(SECRET);
    expect(JSON.stringify(preview.diff)).not.toContain("new-secret-value");
  });

  it("refuses a placeholder with no current value to keep", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs`]: reply({ items: [] }),
    });

    await expect(
      previewChange(ctx, {
        action: "deploy_job",
        spec: `name: fresh\nconfig: { output: { sql: { password: "[redacted]" } } }`,
      }),
    ).rejects.toThrow(
      /config\.output\.sql holds a \[redacted\] value, but the job has no config\.output\.sql/,
    );

    expect(writes()).toHaveLength(0);
  });

  it("refuses a deploy when the job changed after the preview", async () => {
    let current = job("running");

    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: () => Response.json(current),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs/job-1`]: reply({ job: { id: "job-1" } }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      jobId: "job-1",
      spec: NEW_SPEC.replace("edge-logs", "sensor-sink"),
    });

    current = {
      job: {
        id: "job-1",
        spec: { ...CURRENT_SPEC, description: "edited elsewhere" },
      },
    };

    await expect(
      applyChange(ctx, "deploy_job", preview.next.arguments),
    ).rejects.toThrow(/changed after this preview/);

    // Only the dry run reached the workspace.
    expect(writes()).toHaveLength(1);
  });

  it("updates a job of the same name found on a later page", async () => {
    const { ctx, requests } = setup({
      [`GET ${API}/jobs`]: (request) =>
        request.url.searchParams.get("next_token") === "page-2"
          ? Response.json({ items: [job("running").job] })
          : Response.json({
              items: [{ id: "job-0", spec: { name: "sensor-sink-old" } }],
              next_token: "page-2",
            }),
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs/job-1`]: reply({ job: { id: "job-1" } }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      spec: NEW_SPEC.replace("edge-logs", "sensor-sink"),
    });

    expect(
      requests
        .filter((request) => request.url.pathname === "/api/v1/jobs")
        .map((request) => request.url.searchParams.get("prefix")),
    ).toEqual(["sensor-sink", "sensor-sink"]);

    expect(preview.summary).toContain('Update pipeline "sensor-sink"');
    expect(preview.next.arguments).toMatchObject({
      operation: "update",
      jobId: "job-1",
    });
    expect(preview.next.arguments.baseFingerprint).toEqual(expect.any(String));
  });

  it("stops looking for a job by name after a generous cap", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs`]: (request) =>
        Response.json({
          items: Array.from(
            { length: Number(request.url.searchParams.get("limit")) },
            (_, index) => ({ id: `job-${index}`, spec: { name: "other" } }),
          ),
          next_token: "more",
        }),
    });

    await expect(
      previewChange(ctx, { action: "deploy_job", spec: NEW_SPEC }),
    ).rejects.toThrow(/More than 20000 jobs have names starting with/);

    expect(writes()).toHaveLength(0);
  });

  it("refuses a create when a job of that name appeared after the preview", async () => {
    let listed: JsonObject = { items: [] };

    const { ctx, writes } = setup({
      [`GET ${API}/jobs`]: () => Response.json(listed),
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs`]: reply({ job: { id: "job-new" } }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_job",
      spec: NEW_SPEC.replace("edge-logs", "sensor-sink"),
    });

    expect(preview.next.arguments).toMatchObject({ operation: "create" });

    listed = { items: [job("running").job] };

    await expect(
      applyChange(ctx, "deploy_job", preview.next.arguments),
    ).rejects.toThrow(/A job named sensor-sink now exists/);

    // Only the dry run reached the workspace.
    expect(writes()).toHaveLength(1);
  });

  it("reports what the workspace said when the dry run fails", async () => {
    const { ctx } = setup({
      [`GET ${API}/jobs`]: reply({ items: [] }),
      [`PUT ${API}/jobs`]: fail(400, "config.input: unknown input type 'fil'"),
    });

    await expect(
      previewChange(ctx, { action: "deploy_job", spec: NEW_SPEC }),
    ).rejects.toThrow(/rejected this spec.*unknown input type/);
  });
});

describe("deploy_pipeline", () => {
  it("builds a pipeline spec the way Expanso Cloud does", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs`]: reply({ items: [] }),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs`]: reply({ job: { id: "job-p" }, created: true }),
    });

    const { preview, result } = await previewAndApply(ctx, {
      action: "deploy_pipeline",
      name: "stdin-to-stdout",
      config: "input:\n  stdin: {}\noutput:\n  stdout: {}\n",
      selector: { matchIds: ["node-c"] },
    });

    expect(bodyOf(writes()[0])).toEqual({
      dry_run: true,
      spec: {
        name: "stdin-to-stdout",
        type: "pipeline",
        config: { input: { stdin: {} }, output: { stdout: {} } },
        selector: { match_ids: ["node-c"] },
      },
    });

    expect(preview.targetNodes).toMatchObject({
      count: 1,
      names: ["edge-c"],
      selector: "node node-c",
    });

    expect(result.jobId).toBe("job-p");
  });

  it("edits one field of an existing pipeline and keeps the rest", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/nodes`]: reply(NODES),
      [`PUT ${API}/jobs/job-1`]: reply({ job: { id: "job-1" } }),
    });

    const preview = await previewChange(ctx, {
      action: "deploy_pipeline",
      jobId: "job-1",
      description: "Writes sensor readings to Postgres",
    });

    expect(bodyOf(writes()[0])).toMatchObject({
      dry_run: true,
      spec: {
        name: "sensor-sink",
        description: "Writes sensor readings to Postgres",
        config: { output: { sql: { password: SECRET } } },
      },
    });

    expect(preview.diff).toMatchObject({ added: 1, removed: 0 });
    expect(JSON.stringify(preview)).not.toContain(SECRET);
  });
});

describe("confirmation", () => {
  it("refuses arguments that differ from the signed preview", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`POST ${API}/jobs/job-1/stop`]: reply({ job_id: "job-1" }),
    });

    const preview = await previewChange(ctx, {
      action: "stop_job",
      jobId: "job-1",
    });

    for (const tampered of [
      { ...preview.next.arguments, jobId: "job-2" },
      { ...preview.next.arguments, targetNodes: [] },
      { ...preview.next.arguments, reason: "added later" },
      { ...preview.next.arguments, confirmToken: "v1.9999999999.forged" },
    ]) {
      await expect(applyChange(ctx, "stop_job", tampered)).rejects.toThrow();
    }

    // The same preview cannot run a different action either.
    await expect(
      applyChange(ctx, "delete_job", preview.next.arguments),
    ).rejects.toThrow(/differ from the preview/);

    expect(writes()).toHaveLength(0);
  });

  it("refuses a preview signed for another account", async () => {
    const { ctx, writes } = setup(
      {
        [`GET ${API}/jobs/job-1`]: reply(job("running")),
        [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      },
      "acct-someone-else",
    );

    const preview = await previewChange(ctx, {
      action: "rerun_job",
      jobId: "job-1",
    });

    await expect(
      applyChange(ctx, "rerun_job", preview.next.arguments),
    ).rejects.toThrow(/differ from the preview/);

    expect(writes()).toHaveLength(0);
  });

  it("tolerates whitespace a model adds when it re-sends the arguments", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`POST ${API}/jobs/job-1/stop`]: reply({ job_id: "job-1" }),
    });

    const preview = await previewChange(ctx, {
      action: "stop_job",
      jobId: "job-1",
    });

    await applyChange(ctx, "stop_job", {
      ...preview.next.arguments,
      summary: `${String(preview.next.arguments.summary)}  \r\n`,
    });

    expect(writes()).toHaveLength(1);
  });
});

describe("job actions", () => {
  it("stop_job names the nodes it stops and sends the reason", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`POST ${API}/jobs/job-1/stop`]: reply({ job_id: "job-1" }),
    });

    const { preview, result } = await previewAndApply(ctx, {
      action: "stop_job",
      jobId: "job-1",
      reason: "maintenance window",
    });

    expect(preview).toMatchObject({
      destructive: true,
      targetNodes: { count: 2, names: ["node-a", "node-c"] },
    });

    expect(preview.summary).toContain('Stop job "sensor-sink"');
    expect(bodyOf(writes()[0])).toEqual({ reason: "maintenance window" });
    expect(result).toMatchObject({ ok: true, jobId: "job-1" });
  });

  it("rerun_job restarts the job as a new rollout", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("degraded")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`PUT ${API}/jobs/job-1/rerun`]: reply({ job_id: "job-1", version: 4 }),
    });

    const { preview, result } = await previewAndApply(ctx, {
      action: "rerun_job",
      jobId: "job-1",
    });

    expect(preview.destructive).toBe(false);
    expect(writes()[0].url.pathname).toBe("/api/v1/jobs/job-1/rerun");
    expect(result.version).toBe(4);
  });

  it("rerun_job refuses when the job was redeployed after the preview", async () => {
    let current = job("degraded");

    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: () => Response.json(current),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`PUT ${API}/jobs/job-1/rerun`]: reply({ job_id: "job-1", version: 5 }),
    });

    const preview = await previewChange(ctx, {
      action: "rerun_job",
      jobId: "job-1",
    });

    current = {
      job: {
        id: "job-1",
        spec: { ...CURRENT_SPEC, description: "redeployed elsewhere" },
        status: { state: { state_type: "running" }, version: 4 },
      },
    };

    await expect(
      applyChange(ctx, "rerun_job", preview.next.arguments),
    ).rejects.toThrow(/changed after this preview/);

    expect(writes()).toHaveLength(0);
  });

  it("delete_job refuses a running job unless force is previewed", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`DELETE ${API}/jobs/job-1`]: reply({ job_id: "job-1" }),
    });

    await expect(
      previewChange(ctx, { action: "delete_job", jobId: "job-1" }),
    ).rejects.toThrow(/is running\. Stop it first/);

    const { preview } = await previewAndApply(ctx, {
      action: "delete_job",
      jobId: "job-1",
      force: true,
    });

    expect(preview.summary).toContain("stopping its executions on 2 nodes");
    expect(preview.destructive).toBe(true);
    expect(writes()[0].method).toBe("DELETE");
    expect(bodyOf(writes()[0])).toEqual({ force: true });
  });

  it("delete_job deletes a stopped job without force", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("stopped")),
      [`GET ${API}/jobs/job-1/executions`]: reply({ items: [] }),
      [`DELETE ${API}/jobs/job-1`]: reply({ job_id: "job-1" }),
    });

    await previewAndApply(ctx, { action: "delete_job", jobId: "job-1" });

    expect(bodyOf(writes()[0])).toEqual({});
  });

  it("rollback_job previews the diff to the previous version and rolls back", async () => {
    const previous = {
      ...CURRENT_SPEC,
      config: {
        ...CURRENT_SPEC.config,
        output: { sql: { host: "db-0", password: SECRET, options: null } },
      },
    };

    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/versions`]: reply({
        items: [
          { version: 3, spec: CURRENT_SPEC },
          { version: 2, spec: previous },
          { version: 1, spec: previous },
        ],
      }),
      [`POST ${API}/jobs/job-1/rollback`]: reply({
        job_id: "job-1",
        rollback_to_version: 2,
        to_version: 4,
      }),
      [`GET ${API}/nodes`]: reply(NODES),
    });

    const { preview, result } = await previewAndApply(ctx, {
      action: "rollback_job",
      jobId: "job-1",
    });

    expect(bodyOf(writes()[0])).toEqual({ version: 2, dry_run: true });
    expect(bodyOf(writes()[1])).toEqual({ version: 2 });
    expect(preview.summary).toContain("from version 3 to version 2");
    expect(preview.diff?.text).toContain("- ");
    expect(preview.diff?.text).toContain("db-0");
    expect(JSON.stringify(preview)).not.toContain(SECRET);
    expect(result.version).toBe(4);
  });

  it("rollback_job refuses a version that does not exist", async () => {
    const { ctx } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/versions`]: reply({
        items: [{ version: 3, spec: CURRENT_SPEC }],
      }),
    });

    await expect(
      previewChange(ctx, {
        action: "rollback_job",
        jobId: "job-1",
        version: 9,
      }),
    ).rejects.toThrow(/Version 9 of this job was not found/);
  });

  it("pause_rollout warns when no rollout is in progress", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("running")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`POST ${API}/jobs/job-1/rollout/pause`]: reply({ job_id: "job-1" }),
    });

    const { preview } = await previewAndApply(ctx, {
      action: "pause_rollout",
      jobId: "job-1",
    });

    expect(preview.warnings[0]).toMatch(/unless a rollout is in progress/);
    expect(writes()[0].url.pathname).toBe("/api/v1/jobs/job-1/rollout/pause");
  });

  it("resume_rollout resumes a paused rollout", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/jobs/job-1`]: reply(job("rollout_paused")),
      [`GET ${API}/jobs/job-1/executions`]: reply(EXECUTIONS),
      [`POST ${API}/jobs/job-1/rollout/resume`]: reply({ job_id: "job-1" }),
    });

    const { preview } = await previewAndApply(ctx, {
      action: "resume_rollout",
      jobId: "job-1",
    });

    expect(preview.warnings).toEqual([]);
    expect(writes()[0].url.pathname).toBe("/api/v1/jobs/job-1/rollout/resume");
  });
});

describe("delete_node", () => {
  it("refuses a connected node unless force is previewed", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/nodes/node-a`]: reply({ node: NODES.items[0] }),
    });

    await expect(
      previewChange(ctx, { action: "delete_node", nodeId: "node-a" }),
    ).rejects.toThrow(/is connected/);

    expect(writes()).toHaveLength(0);
  });

  it("deletes a disconnected node and names the jobs placed on it", async () => {
    const { ctx, writes } = setup({
      [`GET ${API}/nodes/node-b`]: reply({ node: NODES.items[1] }),
      [`GET ${API}/executions`]: reply({
        items: [
          { id: "ex-9", job_id: "job-1", node_id: "node-b" },
          { id: "ex-8", job_id: "job-1", node_id: "node-b" },
        ],
      }),
      [`DELETE ${API}/nodes/node-b`]: reply({ node_id: "node-b" }),
    });

    const { preview, result } = await previewAndApply(ctx, {
      action: "delete_node",
      nodeId: "node-b",
      reason: "decommissioned",
    });

    expect(preview).toMatchObject({
      destructive: true,
      targetName: "edge-b",
      next: { arguments: { affectedJobs: ["job-1"] } },
    });

    expect(preview.summary).toContain("1 jobs have executions on it");
    expect(bodyOf(writes()[0])).toEqual({ reason: "decommissioned" });
    expect(result.nodeId).toBe("node-b");
  });
});
