import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import { OpenAIExtensions } from "@openai/mcp-extensions/app";
import "@openai/mcp-extensions/app/styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { z } from "zod";
import {
  FleetSummarySchema,
  InventoryPageSchema,
  JobDetailSchema,
  WorkspaceInventorySchema,
  type FleetSummary,
  type JobDetail,
  type WorkspaceInventory,
} from "../../src/mcp/contracts.js";
import { mergeInventory } from "../../src/mcp/groups.js";
import { JobsPanel, NodesPanel } from "./inventory.js";
import "./fleet.css";

const app = new App({ name: "expanso-fleet", version: "0.1.0" });

const openai = new OpenAIExtensions(app);

let setSummaryFromHost: ((summary: FleetSummary) => void) | undefined;

let pendingSummary: FleetSummary | undefined;

// Registered before connect so the initial tool result renders without a refetch.
app.ontoolresult = (result) => {
  const parsed = FleetSummarySchema.safeParse(result.structuredContent);

  if (!parsed.success) return;

  if (setSummaryFromHost) setSummaryFromHost(parsed.data);
  else pendingSummary = parsed.data;
};

function applyHostContext(context: ReturnType<App["getHostContext"]>): void {
  if (context?.theme != null) applyDocumentTheme(context.theme);

  if (context?.styles?.variables != null) {
    applyHostStyleVariables(context.styles.variables);
  }
}

app.addEventListener("hostcontextchanged", applyHostContext);

async function callTool<Schema extends z.ZodType>(
  name: string,
  args: Record<string, string>,
  schema: Schema,
): Promise<z.output<Schema>> {
  const response = await app.callServerTool({ name, arguments: args });

  if (response.isError) {
    const text = response.content.find((item) => item.type === "text");
    throw new Error(text && "text" in text ? text.text : "The request failed.");
  }

  const parsed = schema.safeParse(response.structuredContent);

  if (!parsed.success) throw new Error("The response was not understood.");

  return parsed.data;
}

async function ask(text: string): Promise<void> {
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
  ["failed", "bad"],
  ["rollout_failed", "bad"],
  ["lost", "bad"],
  ["disconnected", "bad"],
]);

function State({ value }: { value: string }) {
  return (
    <span className={`state state-${STATE_TONE.get(value) ?? "none"}`}>
      {value.replace(/_/g, " ")}
    </span>
  );
}

function ago(iso?: string): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);

  if (!Number.isFinite(seconds)) return "";

  if (seconds < 90) return "just now";

  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;

  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;

  return `${Math.round(seconds / 86400)} d ago`;
}

function Fleet() {
  const [summary, setSummary] = useState<FleetSummary | undefined>(
    pendingSummary,
  );

  const [detail, setDetail] = useState<JobDetail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"attention" | "jobs" | "nodes">("attention");
  const [inventory, setInventory] = useState<WorkspaceInventory>();
  const [inventoryError, setInventoryError] = useState<string>();
  const [inventoryLoads, setInventoryLoads] = useState(0);
  const workspaceId = summary?.workspace.id;

  // The whole inventory loads after the first paint, from the app only, and
  // again whenever the summary moves to another workspace.
  useEffect(() => {
    if (!workspaceId) return;

    let current = true;

    setInventoryError(undefined);
    setInventory((loaded) =>
      loaded?.workspaceId === workspaceId ? loaded : undefined,
    );

    callTool("fleet.inventory", { workspaceId }, WorkspaceInventorySchema).then(
      (loaded) => {
        if (current) setInventory(loaded);
      },
      (caught: Error) => {
        if (current) {
          setInventoryError(
            caught instanceof Error
              ? caught.message
              : "Could not load the list.",
          );
        }
      },
    );

    return () => {
      current = false;
    };
  }, [workspaceId, inventoryLoads]);

  useEffect(() => {
    setSummaryFromHost = setSummary;

    return () => {
      setSummaryFromHost = undefined;
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);

    try {
      await work();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "The request failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  const refresh = () =>
    run(async () => {
      setSummary(await callTool("fleet.summary", {}, FleetSummarySchema));
      setInventoryLoads((count) => count + 1);
    });

  const loadMore = (kind: "jobs" | "nodes") =>
    run(async () => {
      const from = inventory;
      const nextToken = from?.[kind].nextToken;

      if (!from || !nextToken) return;

      const page = await callTool(
        "fleet.inventory",
        { workspaceId: from.workspaceId, kind, nextToken },
        InventoryPageSchema,
      );

      if (!page[kind]) throw new Error("The next page was not understood.");

      setInventory((loaded) => {
        if (
          loaded?.workspaceId !== from.workspaceId ||
          loaded[kind].nextToken !== nextToken
        ) {
          return loaded;
        }

        return page.jobs
          ? { ...loaded, jobs: mergeInventory(loaded.jobs, page.jobs) }
          : { ...loaded, nodes: mergeInventory(loaded.nodes, page.nodes!) };
      });
    });

  const openJob = (jobId: string) =>
    run(async () =>
      setDetail(await callTool("get_job", { jobId }, JobDetailSchema)),
    );

  if (!summary) {
    return (
      <main className="fleet" aria-busy="true">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
      </main>
    );
  }

  if (detail) {
    const name = detail.job.name ?? detail.job.id;

    return (
      <main className="fleet">
        <header className="bar">
          <button
            type="button"
            className="btn btn-secondary cursor-interaction"
            onClick={() => setDetail(undefined)}
          >
            Fleet
          </button>
          <h1 className="title">{name}</h1>
          <State value={detail.job.state} />
        </header>
        {detail.job.message && <p className="lede">{detail.job.message}</p>}
        <button
          type="button"
          className="btn btn-primary cursor-interaction"
          onClick={() =>
            void ask(
              `Why is the Expanso job ${name} (${detail.job.id}) ${detail.job.state}? Check its executions, history, and recent logs.`,
            )
          }
        >
          Ask why it is {detail.job.state.replace(/_/g, " ")}
        </button>
        <section>
          <h2>Executions</h2>
          {detail.executions.length === 0 && (
            <p className="empty">No executions.</p>
          )}
          <ul className="rows">
            {detail.executions.map((execution) => (
              <li key={execution.id}>
                <span className="mono">
                  {execution.nodeId ?? "unknown node"}
                </span>
                <State value={execution.state} />
                {execution.message && (
                  <span className="note">{execution.message}</span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <section>
          <h2>History</h2>
          <ul className="rows">
            {detail.history.slice(0, 12).map((event, index) => (
              <li key={`${event.timestamp}-${index}`}>
                <span className="when">{ago(event.timestamp)}</span>
                <span className="note">{event.message}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>
    );
  }

  const { nodes, jobs, recentErrors } = summary;
  const attention = jobs.needsAttention.length;

  return (
    <main className="fleet">
      <header className="bar">
        <h1 className="title">
          {summary.workspace.name ?? summary.workspace.id}
        </h1>
        <button
          type="button"
          className="btn btn-secondary cursor-interaction"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {busy ? "Refreshing" : "Refresh"}
        </button>
      </header>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <dl className="stats">
        <div>
          <dt>Nodes online</dt>
          <dd>
            {nodes.online}
            <small>/{nodes.total}</small>
          </dd>
        </div>
        <div>
          <dt>Jobs running</dt>
          <dd>{jobs.byState.running ?? 0}</dd>
        </div>
        <div>
          <dt>Need attention</dt>
          <dd className={attention > 0 ? "hot" : undefined}>{attention}</dd>
        </div>
      </dl>

      <nav className="tabs" role="tablist" aria-label="Fleet sections">
        {(
          [
            ["attention", "Needs attention"],
            ["jobs", `Jobs${inventory ? ` ${inventory.jobs.total}` : ""}`],
            ["nodes", `Nodes${inventory ? ` ${inventory.nodes.total}` : ""}`],
          ] as const
        ).map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`tab cursor-interaction${tab === key ? " tab-on" : ""}`}
            onClick={() => setTab(key)}
          >
            {text}
          </button>
        ))}
      </nav>

      {tab !== "attention" && inventoryError && (
        <p className="error" role="alert">
          {inventoryError}
        </p>
      )}

      {tab !== "attention" && !inventory && !inventoryError && (
        <div aria-busy="true">
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
          <div className="skeleton skeleton-row" />
        </div>
      )}

      {tab === "jobs" && inventory && (
        <JobsPanel
          inventory={inventory.jobs}
          busy={busy}
          onLoadMore={() => void loadMore("jobs")}
          renderJob={(job) => (
            <li key={job.id}>
              <button
                type="button"
                className="link cursor-interaction"
                onClick={() => void openJob(job.id)}
              >
                {job.name ?? job.id}
              </button>
              <State value={job.state} />
              <span className="when">{ago(job.updatedAt)}</span>
              {job.message && <span className="note">{job.message}</span>}
            </li>
          )}
        />
      )}

      {tab === "nodes" && inventory && (
        <NodesPanel
          inventory={inventory.nodes}
          busy={busy}
          onLoadMore={() => void loadMore("nodes")}
          renderNode={(node) => (
            <li key={node.id}>
              <span className="mono">{node.name ?? node.id}</span>
              <State value={node.connectionState} />
              <span className="when">
                {node.lastHeartbeat ? `seen ${ago(node.lastHeartbeat)}` : ""}
              </span>
              {node.message && <span className="note">{node.message}</span>}
            </li>
          )}
        />
      )}

      {tab === "attention" && (
        <>
          <section>
            <h2>Jobs needing attention</h2>
            {attention === 0 && <p className="empty">Every job is healthy.</p>}
            <ul className="rows">
              {jobs.needsAttention.map((job) => (
                <li key={job.id}>
                  <button
                    type="button"
                    className="link cursor-interaction"
                    onClick={() => void openJob(job.id)}
                  >
                    {job.name ?? job.id}
                  </button>
                  <State value={job.state} />
                  {job.message && <span className="note">{job.message}</span>}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h2>Recent failed or degraded executions</h2>
            {recentErrors.length === 0 && <p className="empty">None.</p>}
            <ul className="rows">
              {recentErrors.map((execution) => (
                <li key={execution.id}>
                  {execution.jobId ? (
                    <button
                      type="button"
                      className="link cursor-interaction"
                      onClick={() => void openJob(execution.jobId!)}
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

          {nodes.offline.length > 0 && (
            <section>
              <h2>Offline nodes</h2>
              <ul className="rows">
                {nodes.offline.map((node) => (
                  <li key={node.id}>
                    <span className="mono">{node.name ?? node.id}</span>
                    <State value={node.connectionState} />
                    <span className="when">
                      {node.lastHeartbeat
                        ? `seen ${ago(node.lastHeartbeat)}`
                        : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
      <footer className="foot">
        Read-only view. Updated {ago(summary.generatedAt)}.
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fleet />
  </StrictMode>,
);

await app.connect();

applyHostContext(app.getHostContext());
