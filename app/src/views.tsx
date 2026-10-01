import { useEffect, useState } from "react";
import { z } from "zod";
import {
  ChangePreviewSchema,
  ChangeResultSchema,
  DashboardSchema,
  FleetsViewSchema,
  JobDashboardSchema,
  NodeDetailSchema,
  type ChangePreview,
  type ChangeResult,
  type Dashboard,
  type FleetsView,
  type JobDashboard,
  type NodeDetail,
} from "../../src/mcp/contracts.js";
import { Bars, Sparkline, total } from "./charts.js";
import { ago, app, ask, callTool, errorText, State } from "./shared.js";

/** Loads a tool result when `deps` change; `reload` fetches again. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let current = true;

    setError(undefined);

    load().then(
      (loaded) => {
        if (current) setValue(loaded);
      },
      (caught: Error) => {
        if (current) setError(errorText(caught, "Could not load this view."));
      },
    );

    return () => {
      current = false;
    };
  }, [...deps, loads]); // `load` is rebuilt every render; deps say when it changes.

  return { value, error, reload: () => setLoads((count) => count + 1) };
}

function Loading() {
  return (
    <div aria-busy="true">
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
      <div className="skeleton skeleton-row" />
    </div>
  );
}

function counts(record: Record<string, number>): string {
  return (
    Object.entries(record)
      .map(([state, count]) => `${count} ${state.replace(/_/g, " ")}`)
      .join(", ") || "none"
  );
}

// ------------------------------------------------------------ changes

export interface ChangeRequest {
  action: string;
  jobId?: string;
  nodeId?: string;
  version?: number;
  force?: boolean;
}

/**
 * Previews a change, shows exactly what it will do, and runs it only when
 * the person presses the confirm button. The write tool gets the preview's
 * signed arguments unchanged.
 */
export function ConfirmChange({
  request,
  onClose,
  onDone,
}: {
  request: ChangeRequest;
  onClose: () => void;
  onDone: (result: ChangeResult) => void;
}) {
  const [preview, setPreview] = useState<ChangePreview>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  useEffect(() => {
    let current = true;

    callTool("preview_change", { ...request }, ChangePreviewSchema).then(
      (loaded) => {
        if (current) setPreview(loaded);
      },
      (caught: Error) => {
        if (current) setError(errorText(caught));
      },
    );

    return () => {
      current = false;
    };
  }, [request]);

  const confirm = async () => {
    if (!preview) return;

    setRunning(true);
    setError(undefined);

    try {
      onDone(
        await callTool(
          preview.next.tool,
          preview.next.arguments,
          ChangeResultSchema,
        ),
      );
    } catch (caught) {
      setError(errorText(caught instanceof Error ? caught : undefined));
      setRunning(false);
    }
  };

  return (
    <section
      className={`confirm${preview?.destructive ? " confirm-danger" : ""}`}
      aria-live="polite"
    >
      <h2>
        {preview?.destructive ? "Confirm destructive change" : "Confirm change"}
      </h2>
      {!preview && !error && <Loading />}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {preview && (
        <>
          <p className="lede">{preview.summary}</p>
          {preview.targetNodes.count > 0 && (
            <p className="note">
              Nodes ({preview.targetNodes.count}
              {preview.targetNodes.more ? "+" : ""}):{" "}
              <span className="mono">
                {preview.targetNodes.names.join(", ")}
              </span>
              {preview.targetNodes.selector &&
                ` (selector ${preview.targetNodes.selector})`}
            </p>
          )}
          {preview.diff?.text && (
            <pre className="diff" aria-label="Spec changes">
              {preview.diff.text.split("\n").map((line, index) => (
                <span
                  key={index}
                  className={
                    line.startsWith("+ ")
                      ? "diff-add"
                      : line.startsWith("- ")
                        ? "diff-del"
                        : undefined
                  }
                >
                  {line}
                  {"\n"}
                </span>
              ))}
              {preview.diff.truncated && "… (diff truncated)"}
            </pre>
          )}
          {preview.warnings.map((warning) => (
            <p key={warning} className="warn">
              {warning}
            </p>
          ))}
        </>
      )}
      <div className="actions">
        <button
          type="button"
          className={`btn ${preview?.destructive ? "btn-danger" : "btn-primary"} cursor-interaction`}
          disabled={!preview || running}
          onClick={() => void confirm()}
        >
          {running
            ? "Working"
            : preview?.destructive
              ? "Yes, do it"
              : "Confirm"}
        </button>
        <button
          type="button"
          className="btn btn-secondary cursor-interaction"
          disabled={running}
          onClick={onClose}
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

function Done({ result }: { result: ChangeResult }) {
  return (
    <p className="done" role="status">
      {result.summary}
      {result.warnings.length > 0 && ` Warnings: ${result.warnings.join("; ")}`}
    </p>
  );
}

// ---------------------------------------------------------- dashboard

export function DashboardPanel({
  workspaceId,
  onOpenJob,
  onOpenNode,
}: {
  workspaceId: string;
  onOpenJob: (jobId: string) => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const { value, error } = useLoad<Dashboard>(
    () => callTool("fleet.dashboard", {}, DashboardSchema),
    [workspaceId],
  );

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }

  if (!value) return <Loading />;

  const health = value.health.points;
  const lastHealth = health.at(-1);
  const failed = value.failures.total;
  const placed = total(value.activity.buckets, ["placed"]);
  const finished = total(value.activity.buckets, ["finished"]);

  return (
    <div className="dashboard">
      <dl className="stats">
        <div>
          <dt>Average CPU</dt>
          <dd>
            {value.nodes.resources?.cpu.avg ?? "–"}
            <small>%</small>
          </dd>
        </div>
        <div>
          <dt>Executions running</dt>
          <dd>{value.executions.byState.running ?? 0}</dd>
        </div>
        <div>
          <dt>Failures, {value.failures.windowHours} h</dt>
          <dd className={failed > 0 ? "hot" : undefined}>{failed}</dd>
        </div>
      </dl>

      <section>
        <h2>Nodes reporting, last {value.health.windowMinutes} min</h2>
        <Sparkline
          values={health.map((point) => point.nodesReporting)}
          max={Math.max(value.nodes.total, 1)}
          tone="good"
          label={`Nodes reporting per minute, now ${lastHealth?.nodesReporting ?? 0} of ${value.nodes.total}.`}
        />
      </section>

      <section>
        <h2>Average node CPU, last {value.health.windowMinutes} min</h2>
        <Sparkline
          values={health.map((point) => point.cpuAvgPercent)}
          max={100}
          label={`Average CPU per minute, now ${lastHealth?.cpuAvgPercent ?? "unknown"} percent, peak ${lastHealth?.cpuMaxPercent ?? "unknown"} percent.`}
        />
        {lastHealth?.cpuAvgPercent !== undefined && (
          <p className="when">
            Now {lastHealth.cpuAvgPercent}% average, {lastHealth.cpuMaxPercent}%
            busiest node
          </p>
        )}
      </section>

      <section>
        <h2>Executions per hour, last {value.activity.windowHours} h</h2>
        <Bars
          buckets={value.activity.buckets}
          series={[{ key: "placed", tone: "none" }]}
          label={`${placed} executions placed and ${finished} finished in the last ${value.activity.windowHours} hours.`}
        />
        <p className="when">
          {placed} placed, {finished} finished (from the{" "}
          {value.activity.sampled} most recent executions)
        </p>
      </section>

      <section>
        <h2>Failures per hour</h2>
        <Bars
          buckets={value.failures.buckets}
          series={[
            { key: "failed", tone: "bad" },
            { key: "lost", tone: "bad" },
            { key: "degraded", tone: "warn" },
          ]}
          label={`${failed} failed, lost, or degraded executions in the last ${value.failures.windowHours} hours.`}
        />
        {value.failures.topJobs.length > 0 ? (
          <ul className="rows">
            {value.failures.topJobs.map((job) => (
              <li key={job.jobId}>
                <button
                  type="button"
                  className="link cursor-interaction"
                  onClick={() => onOpenJob(job.jobId)}
                >
                  {job.name ?? job.jobId}
                </button>
                <span className="when">{job.count} failures</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty">No failures in this window.</p>
        )}
      </section>

      <section>
        <h2>Nodes</h2>
        <table className="grid">
          <thead>
            <tr>
              <th scope="col">Node</th>
              <th scope="col">State</th>
              <th scope="col">CPU</th>
              <th scope="col">Mem</th>
              <th scope="col">Disk</th>
              <th scope="col">CPU, 30 min</th>
            </tr>
          </thead>
          <tbody>
            {value.topNodes.map((node) => (
              <tr key={node.id}>
                <td>
                  <button
                    type="button"
                    className="link cursor-interaction"
                    onClick={() => onOpenNode(node.id)}
                  >
                    {node.name ?? node.id}
                  </button>
                </td>
                <td>
                  <State value={node.connectionState} />
                </td>
                <td className="num">{percent(node.cpuPercent)}</td>
                <td className="num">{percent(node.memoryPercent)}</td>
                <td className="num">{percent(node.diskPercent)}</td>
                <td className="spark-cell">
                  <Sparkline
                    values={node.cpuSeries}
                    max={100}
                    height={18}
                    label={`CPU for ${node.name ?? node.id}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {value.notes.map((note) => (
        <p key={note} className="foot">
          {note}
        </p>
      ))}
    </div>
  );
}

function percent(value?: number): string {
  return value === undefined ? "–" : `${Math.round(value)}%`;
}

// ------------------------------------------------------------- fleets

const AddLinkSchema = z.object({ url: z.string() });

export function FleetsPanel({ onSwitched }: { onSwitched: () => void }) {
  const { value, error, reload } = useLoad<FleetsView>(
    () => callTool("fleets.list", {}, FleetsViewSchema),
    [],
  );

  const [switching, setSwitching] = useState<string>();
  const [switchError, setSwitchError] = useState<string>();

  const act = async (workspaceId: string, work: () => Promise<void>) => {
    setSwitching(workspaceId);
    setSwitchError(undefined);

    try {
      await work();
    } catch (caught) {
      setSwitchError(errorText(caught instanceof Error ? caught : undefined));
    } finally {
      setSwitching(undefined);
    }
  };

  const switchTo = (workspaceId: string) =>
    act(workspaceId, async () => {
      await callTool("switch_workspace", { workspaceId }, z.looseObject({}));
      reload();
      onSwitched();
    });

  // A one-time link to the page where the person pastes a key; the key never
  // passes through ChatGPT.
  const connect = (workspaceId: string, known: boolean) =>
    act(workspaceId, async () => {
      const link = await callTool(
        "add_workspace",
        known ? { workspaceId } : {},
        AddLinkSchema,
      );

      const { isError } = await app.openLink({ url: link.url });

      if (isError) {
        throw new Error(
          "The link did not open. Ask Expanso Fleet in the chat to connect a workspace for a new link.",
        );
      }
    });

  if (error) {
    return (
      <p className="error" role="alert">
        {error}
      </p>
    );
  }

  if (!value) return <Loading />;

  return (
    <section className="fleets">
      {switchError && (
        <p className="error" role="alert">
          {switchError}
        </p>
      )}
      <ul className="rows">
        {value.fleets.map((fleet) => {
          const status = fleet.status;

          return (
            <li key={fleet.id} className="fleet-row">
              <span className="fleet-name">
                <strong>{fleet.name ?? fleet.id}</strong>
                {fleet.organizationName && (
                  <span className="when"> {fleet.organizationName}</span>
                )}
              </span>
              {fleet.active && <span className="state state-good">active</span>}
              {fleet.needsReconnect && (
                <span className="state state-bad">needs reconnecting</span>
              )}
              <span
                className={`state ${fleet.linked ? "state-none" : "state-warn"}`}
              >
                {fleet.linked ? "connected" : "not connected"}
              </span>
              {fleet.linked && (
                <span className="when">
                  {fleet.keyExpiresAt
                    ? `key expires ${new Date(fleet.keyExpiresAt).toLocaleDateString()}`
                    : fleet.keyExpiresAt === undefined
                      ? "key expiry not reported"
                      : "key never expires"}
                </span>
              )}
              <span className="note">
                {status
                  ? `${status.nodesHealthy ?? "?"} healthy, ${status.nodesUnhealthy ?? "?"} unhealthy nodes · ${status.jobsRunning ?? "?"} running, ${status.jobsFailing ?? "?"} failing jobs${status.jobsCountedFrom ? ` (newest ${status.jobsCountedFrom})` : ""}${status.lastActivityAt ? ` · active ${ago(status.lastActivityAt)}` : ""}`
                  : (fleet.statusError ??
                    (fleet.linked
                      ? "Switch to this workspace to read its status."
                      : "Status is available once this workspace is connected."))}
              </span>
              <span className="actions">
                {fleet.needsReconnect && (
                  <button
                    type="button"
                    className="btn btn-primary cursor-interaction"
                    disabled={switching !== undefined}
                    onClick={() => void connect(fleet.id, true)}
                  >
                    Reconnect
                  </button>
                )}
                {fleet.linked && !fleet.active && (
                  <button
                    type="button"
                    className="btn btn-secondary cursor-interaction"
                    disabled={switching !== undefined}
                    onClick={() => void switchTo(fleet.id)}
                  >
                    {switching === fleet.id ? "Switching" : "Switch"}
                  </button>
                )}
                {!fleet.linked && (
                  <button
                    type="button"
                    className="btn btn-secondary cursor-interaction"
                    disabled={switching !== undefined}
                    onClick={() => void connect(fleet.id, false)}
                  >
                    Connect
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {!value.directoryAvailable && (
        <p className="foot">
          Showing the workspaces this connection links. Other workspaces in your
          organization appear here once Expanso Cloud lists them.
        </p>
      )}
    </section>
  );
}

// -------------------------------------------------------- node detail

export function NodeView({
  workspaceId,
  nodeId,
  onBack,
  onOpenJob,
}: {
  workspaceId: string;
  nodeId: string;
  onBack: () => void;
  onOpenJob: (jobId: string) => void;
}) {
  const { value, error, reload } = useLoad<NodeDetail>(
    () => callTool("node_dashboard", { nodeId }, NodeDetailSchema),
    [workspaceId, nodeId],
  );

  const [change, setChange] = useState<ChangeRequest>();
  const [done, setDone] = useState<ChangeResult>();

  const name = value?.node.name ?? nodeId;
  const points = value?.resources.points ?? [];

  return (
    <main className="fleet">
      <header className="bar">
        <button
          type="button"
          className="btn btn-secondary cursor-interaction"
          onClick={onBack}
        >
          Fleet
        </button>
        <h1 className="title">{name}</h1>
        {value && <State value={value.node.connectionState} />}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!value && !error && <Loading />}
      {done && <Done result={done} />}
      {value && (
        <>
          <p className="lede">
            {value.node.os ?? "?"}/{value.node.arch ?? "?"} · agent{" "}
            {value.node.agentVersion ?? "unknown"}
            {value.node.lastHeartbeat &&
              ` · seen ${ago(value.node.lastHeartbeat)}`}
          </p>
          <section>
            <h2>CPU, last {value.resources.windowMinutes} min</h2>
            <Sparkline
              values={points.map((point) => point.cpuPercent)}
              max={100}
              label={`CPU percent for ${name}, now ${points.at(-1)?.cpuPercent ?? "unknown"}.`}
            />
          </section>
          <section>
            <h2>Memory used</h2>
            <Sparkline
              values={points.map((point) => point.memoryBytes)}
              label={`Memory used by ${name}.`}
            />
          </section>
          <section>
            <h2>Disk used</h2>
            <Sparkline
              values={points.map((point) => point.diskBytes)}
              label={`Disk used by ${name}.`}
            />
          </section>
          <section>
            <h2>Executions: {counts(value.executionsByState)}</h2>
            <ul className="rows">
              {value.executions.map((execution) => (
                <li key={execution.id}>
                  {execution.jobId ? (
                    <button
                      type="button"
                      className="link cursor-interaction"
                      onClick={() => onOpenJob(execution.jobId!)}
                    >
                      {execution.jobId}
                    </button>
                  ) : (
                    <span className="mono">{execution.id}</span>
                  )}
                  <State value={execution.state} />
                  <span className="when">{ago(execution.updatedAt)}</span>
                  {execution.message && (
                    <span className="note">{execution.message}</span>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {change ? (
            <ConfirmChange
              request={change}
              onClose={() => setChange(undefined)}
              onDone={(result) => {
                setChange(undefined);
                setDone(result);
                reload();
              }}
            />
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn-danger cursor-interaction"
                onClick={() =>
                  setChange({
                    action: "delete_node",
                    nodeId,
                    force: value.node.online || undefined,
                  })
                }
              >
                Delete node
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

// --------------------------------------------------------- job detail

export function JobView({
  workspaceId,
  jobId,
  onBack,
}: {
  workspaceId: string;
  jobId: string;
  onBack: () => void;
}) {
  const { value, error, reload } = useLoad<JobDashboard>(
    () => callTool("job_dashboard", { jobId }, JobDashboardSchema),
    [workspaceId, jobId],
  );

  const [change, setChange] = useState<ChangeRequest>();
  const [done, setDone] = useState<ChangeResult>();

  const job = value?.job;
  const name = job?.name ?? jobId;
  const failures = value ? total(value.failures) : 0;

  const act = (action: string, extra: Partial<ChangeRequest> = {}) =>
    setChange({ action, jobId, ...extra });

  const previous = value?.versions.find(
    (version) => job?.version !== undefined && version.version < job.version,
  );

  return (
    <main className="fleet">
      <header className="bar">
        <button
          type="button"
          className="btn btn-secondary cursor-interaction"
          onClick={onBack}
        >
          Fleet
        </button>
        <h1 className="title">{name}</h1>
        {job && <State value={job.state} />}
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!value && !error && <Loading />}
      {done && <Done result={done} />}
      {value && job && (
        <>
          {job.message && <p className="lede">{job.message}</p>}
          {change ? (
            <ConfirmChange
              request={change}
              onClose={() => setChange(undefined)}
              onDone={(result) => {
                setChange(undefined);
                setDone(result);
                reload();
              }}
            />
          ) : (
            <div className="actions">
              <button
                type="button"
                className="btn btn-primary cursor-interaction"
                onClick={() =>
                  void ask(
                    `Why is the Expanso job ${name} (${job.id}) ${job.state}? Check its executions, history, and recent logs.`,
                  )
                }
              >
                Ask why it is {job.state.replace(/_/g, " ")}
              </button>
              <button
                type="button"
                className="btn btn-secondary cursor-interaction"
                onClick={() => act("rerun_job")}
              >
                Rerun
              </button>
              {job.state === "deploying" && (
                <button
                  type="button"
                  className="btn btn-secondary cursor-interaction"
                  onClick={() => act("pause_rollout")}
                >
                  Pause rollout
                </button>
              )}
              {job.state === "rollout_paused" && (
                <button
                  type="button"
                  className="btn btn-secondary cursor-interaction"
                  onClick={() => act("resume_rollout")}
                >
                  Resume rollout
                </button>
              )}
              {previous && (
                <button
                  type="button"
                  className="btn btn-secondary cursor-interaction"
                  onClick={() =>
                    act("rollback_job", { version: previous.version })
                  }
                >
                  Roll back to v{previous.version}
                </button>
              )}
              {job.state !== "stopped" && (
                <button
                  type="button"
                  className="btn btn-danger cursor-interaction"
                  onClick={() => act("stop_job")}
                >
                  Stop
                </button>
              )}
              <button
                type="button"
                className="btn btn-danger cursor-interaction"
                onClick={() =>
                  act("delete_job", {
                    force:
                      !["stopped", "completed", "failed"].includes(job.state) ||
                      undefined,
                  })
                }
              >
                Delete
              </button>
            </div>
          )}
          <section>
            <h2>
              On {value.nodes.length} nodes: {counts(value.executionsByState)}
            </h2>
            <ul className="rows">
              {value.nodes.map((node) => (
                <li key={node.nodeId}>
                  <span className="mono">{node.nodeId}</span>
                  <State value={node.state} />
                  <span className="when">{ago(node.updatedAt)}</span>
                  {node.message && <span className="note">{node.message}</span>}
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h2>Failures per hour, last 24 h</h2>
            <Bars
              buckets={value.failures}
              series={[
                { key: "failed", tone: "bad" },
                { key: "lost", tone: "bad" },
                { key: "degraded", tone: "warn" },
              ]}
              label={`${failures} failed, lost, or degraded executions in the last 24 hours.`}
            />
            <p className="when">{failures} in the last 24 h</p>
          </section>
          <section>
            <h2>History</h2>
            <ul className="rows">
              {value.history.slice(0, 12).map((event, index) => (
                <li key={`${event.timestamp}-${index}`}>
                  <span className="when">{ago(event.timestamp)}</span>
                  <span className="note">{event.message}</span>
                </li>
              ))}
            </ul>
          </section>
          {value.versions.length > 0 && (
            <section>
              <h2>Versions</h2>
              <ul className="rows">
                {value.versions.slice(0, 8).map((version) => (
                  <li key={version.version}>
                    <span className="mono">v{version.version}</span>
                    {version.state && <State value={version.state} />}
                    <span className="when">{ago(version.updatedAt)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
