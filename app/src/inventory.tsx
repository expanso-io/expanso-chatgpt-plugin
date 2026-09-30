import { useMemo, useState, type ReactNode } from "react";
import type {
  InventoryGroup,
  JobView,
  NodeView,
  WorkspaceInventory,
} from "../../src/mcp/contracts.js";

/** Rows rendered at first and added per "Show more". */
const PAGE = 100;

type Health = "all" | "healthy" | "not-healthy";

interface Item {
  id: string;
  name?: string;
}

interface PanelProps<View extends Item> {
  noun: string;
  inventory: WorkspaceInventory["jobs"] | WorkspaceInventory["nodes"];
  groups: InventoryGroup<View>[];
  renderItem: (item: View) => ReactNode;
}

function label(state: string): string {
  return state.replace(/_/g, " ");
}

/** One kind of inventory, grouped by state, with filters and paging. */
function Panel<View extends Item>({
  noun,
  inventory,
  groups,
  renderItem,
}: PanelProps<View>) {
  const [health, setHealth] = useState<Health>("all");
  const [state, setState] = useState<string>();
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(PAGE);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return groups
      .filter((group) => !state || group.state === state)
      .filter(
        (group) => health === "all" || group.healthy === (health === "healthy"),
      )
      .map((group) => ({
        ...group,
        items: needle
          ? group.items.filter((item) =>
              `${item.name ?? ""} ${item.id}`.toLowerCase().includes(needle),
            )
          : group.items,
      }))
      .filter((group) => group.items.length > 0);
  }, [groups, health, state, query]);

  const matching = visible.reduce((sum, group) => sum + group.items.length, 0);
  let budget = shown;

  const choose = (next: Health, nextState?: string) => {
    setHealth(next);
    setState(nextState);
    setShown(PAGE);
  };

  return (
    <div className="inventory">
      <div className="chips" role="group" aria-label={`Filter ${noun}`}>
        <Chip active={health === "all" && !state} onClick={() => choose("all")}>
          All {inventory.total}
        </Chip>
        <Chip
          active={health === "healthy" && !state}
          onClick={() => choose("healthy")}
        >
          Healthy {inventory.healthy}
        </Chip>
        <Chip
          active={health === "not-healthy" && !state}
          tone={inventory.notHealthy > 0 ? "bad" : undefined}
          onClick={() => choose("not-healthy")}
        >
          Not healthy {inventory.notHealthy}
        </Chip>
        {groups.map((group) => (
          <Chip
            key={group.state}
            active={state === group.state}
            onClick={() => choose("all", group.state)}
          >
            {label(group.state)} {group.count}
          </Chip>
        ))}
      </div>
      <input
        className="form-control search"
        type="search"
        placeholder={`Find ${noun} by name or ID`}
        aria-label={`Find ${noun} by name or ID`}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setShown(PAGE);
        }}
      />
      {inventory.truncated && (
        <p className="note">
          This workspace has more {noun} than were loaded; counts cover the
          first {inventory.total}.
        </p>
      )}
      {matching === 0 && <p className="empty">No {noun} match.</p>}
      {visible.map((group) => {
        if (budget <= 0) return null;

        const rows = group.items.slice(0, budget);

        budget -= rows.length;

        return (
          <section key={group.state}>
            <h2>
              {label(group.state)}{" "}
              <span className="count">{group.items.length}</span>
            </h2>
            <ul className="rows">{rows.map(renderItem)}</ul>
          </section>
        );
      })}
      {matching > shown && (
        <button
          type="button"
          className="btn btn-secondary cursor-interaction"
          onClick={() => setShown(shown + PAGE)}
        >
          Show {Math.min(PAGE, matching - shown)} more of {matching - shown}
        </button>
      )}
    </div>
  );
}

function Chip({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone?: "bad";
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`chip cursor-interaction${active ? " chip-on" : ""}${tone ? ` chip-${tone}` : ""}`}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function JobsPanel({
  inventory,
  renderJob,
}: {
  inventory: WorkspaceInventory["jobs"];
  renderJob: (job: JobView) => ReactNode;
}) {
  return (
    <Panel
      noun="jobs"
      inventory={inventory}
      groups={inventory.groups}
      renderItem={renderJob}
    />
  );
}

export function NodesPanel({
  inventory,
  renderNode,
}: {
  inventory: WorkspaceInventory["nodes"];
  renderNode: (node: NodeView) => ReactNode;
}) {
  return (
    <Panel
      noun="nodes"
      inventory={inventory}
      groups={inventory.groups}
      renderItem={renderNode}
    />
  );
}
