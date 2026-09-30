import type { InventoryGroup, KindInventory } from "./contracts.js";

/** Job states that need someone to look, listed first. */
const ATTENTION_JOB_ORDER = ["failed", "rollout_failed", "degraded", "queued"];

function stateRank(state: string, healthy: boolean): number {
  const attention = ATTENTION_JOB_ORDER.indexOf(state);

  if (attention >= 0) return attention;

  return healthy ? 100 : 50;
}

/** Problems first, then other states, healthy last; larger groups first. */
export function sortGroups<View>(
  groups: InventoryGroup<View>[],
): InventoryGroup<View>[] {
  return groups.sort(
    (a, b) =>
      stateRank(a.state, a.healthy) - stateRank(b.state, b.healthy) ||
      b.count - a.count,
  );
}

/** Adds a continuation page to what is already loaded. */
export function mergeInventory<View>(
  loaded: KindInventory<View>,
  page: KindInventory<View>,
): KindInventory<View> {
  const groups = new Map(
    loaded.groups.map((group) => [
      group.state,
      { ...group, items: [...group.items] },
    ]),
  );

  for (const group of page.groups) {
    const existing = groups.get(group.state);

    if (existing) {
      existing.count += group.count;
      existing.items.push(...group.items);
    } else {
      groups.set(group.state, { ...group, items: [...group.items] });
    }
  }

  const counts = loaded.countsComplete
    ? loaded
    : {
        total: loaded.total + page.total,
        healthy: loaded.healthy + page.healthy,
        notHealthy: loaded.notHealthy + page.notHealthy,
      };

  return {
    total: counts.total,
    healthy: counts.healthy,
    notHealthy: counts.notHealthy,
    countsComplete: loaded.countsComplete || page.nextToken === undefined,
    nextToken: page.nextToken,
    groups: sortGroups([...groups.values()]),
  };
}
