import {
  applyDocumentTheme,
  applyHostStyleVariables,
  type App,
} from "@modelcontextprotocol/ext-apps";
import "@openai/mcp-extensions/app/styles.css";
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ConnectionStateSchema,
  FleetSummarySchema,
  InventoryPageSchema,
  WorkspaceInventorySchema,
  type ConnectionStateView,
  type FleetSummary,
  type WorkspaceInventory,
} from "../../src/mcp/contracts.js";
import { mergeInventory } from "../../src/mcp/groups.js";
import { JobsPanel, NodesPanel } from "./inventory.js";
import { ago, app, callTool, ConnectionNeeded, State } from "./shared.js";
import { DashboardPanel, FleetsPanel, JobView, NodeView } from "./views.js";
import "./fleet.css";

let setSummaryFromHost: ((summary: FleetSummary) => void) | undefined;

let setConnectionFromHost:
  ((connection: ConnectionStateView["connection"]) => void) | undefined;

let pendingSummary: FleetSummary | undefined;

let pendingConnection: ConnectionStateView["connection"] | undefined;

// Registered before connect so the initial tool result renders without a refetch.
app.ontoolresult = (result) => {
  const connection = ConnectionStateSchema.safeParse(result.structuredContent);

  if (connection.success) {
    if (setConnectionFromHost)
      setConnectionFromHost(connection.data.connection);
    else pendingConnection = connection.data.connection;

    return;
  }

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

type Tab = "attention" | "dashboard" | "jobs" | "nodes" | "fleets";

/** One clear action when the workspace needs connecting or reconnecting. */
function Reconnect({
  connection,
}: {
  connection: ConnectionStateView["connection"];
}) {
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const reconnect = connection.status === "reconnect";

  const openLink = async () => {
    setOpening(true);
    setFailed(false);

    try {
      const { isError } = await app.openLink({ url: connection.reconnectUrl });

      setFailed(Boolean(isError));
    } catch {
      setFailed(true);
    } finally {
      setOpening(false);
    }
  };

  return (
    <main className="fleet">
      <section className="reconnect" aria-labelledby="reconnect-title">
        <h1 id="reconnect-title" className="title">
          {reconnect
            ? `Reconnect ${connection.workspaceId ?? "your workspace"}`
            : "Connect a workspace"}
        </h1>
        <p className="lede">{connection.message}</p>
        <button
          type="button"
          className="btn btn-primary cursor-interaction"
          disabled={opening}
          onClick={() => void openLink()}
        >
          {reconnect ? "Reconnect" : "Connect"}
        </button>
        {failed && (
          <p className="note" role="alert">
            The link did not open. Ask Expanso Fleet in the chat to connect a
            workspace for a new link.
          </p>
        )}
        <p className="foot">
          The link works once, for ten minutes. You paste a new API key there;
          ChatGPT never sees it.
        </p>
      </section>
    </main>
  );
}

function Fleet() {
  const [summary, setSummary] = useState<FleetSummary | undefined>(
    pendingSummary,
  );

  const [connection, setConnection] = useState<
    ConnectionStateView["connection"] | undefined
  >(pendingConnection);

  const [openJob, setOpenJob] = useState<string>();
  const [openNode, setOpenNode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<Tab>("attention");
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
    setSummaryFromHost = (next) => {
      setConnection(undefined);
      setSummary(next);
    };

    setConnectionFromHost = setConnection;

    return () => {
      setSummaryFromHost = undefined;
      setConnectionFromHost = undefined;
    };
  }, []);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);

    try {
      await work();
    } catch (caught) {
      if (caught instanceof ConnectionNeeded) setConnection(caught.connection);
      else {
        setError(
          caught instanceof Error ? caught.message : "The request failed.",
        );
      }
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

  if (connection) return <Reconnect connection={connection} />;

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

  if (openJob) {
    return (
      <JobView
        workspaceId={summary.workspace.id}
        jobId={openJob}
        onBack={() => {
          setOpenJob(undefined);
          void refresh();
        }}
      />
    );
  }

  if (openNode) {
    return (
      <NodeView
        workspaceId={summary.workspace.id}
        nodeId={openNode}
        onBack={() => {
          setOpenNode(undefined);
          void refresh();
        }}
        onOpenJob={(jobId) => {
          setOpenNode(undefined);
          setOpenJob(jobId);
        }}
      />
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
      {summary.notice && (
        <p className="notice" role="status">
          {summary.notice}
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
            ["dashboard", "Dashboard"],
            ["jobs", `Jobs${inventory ? ` ${inventory.jobs.total}` : ""}`],
            ["nodes", `Nodes${inventory ? ` ${inventory.nodes.total}` : ""}`],
            ["fleets", "Fleets"],
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

      {tab === "dashboard" && (
        <DashboardPanel
          workspaceId={summary.workspace.id}
          onOpenJob={setOpenJob}
          onOpenNode={setOpenNode}
        />
      )}

      {tab === "fleets" && <FleetsPanel onSwitched={() => void refresh()} />}

      {(tab === "jobs" || tab === "nodes") && inventoryError && (
        <p className="error" role="alert">
          {inventoryError}
        </p>
      )}

      {(tab === "jobs" || tab === "nodes") && !inventory && !inventoryError && (
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
                onClick={() => setOpenJob(job.id)}
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
              <button
                type="button"
                className="link cursor-interaction"
                onClick={() => setOpenNode(node.id)}
              >
                {node.name ?? node.id}
              </button>
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
                    onClick={() => setOpenJob(job.id)}
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
                      onClick={() => setOpenJob(execution.jobId!)}
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
        Updated {ago(summary.generatedAt)}. Changes ask you to confirm first.
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
