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

/** Adds a continuation page to what is already loaded, skipping rows already shown. */
export function mergeInventory<View extends { id: string }>(
  loaded: KindInventory<View>,
  page: KindInventory<View>,
): KindInventory<View> {
  const seen = new Set(
    loaded.groups.flatMap((group) => group.items.map((item) => item.id)),
  );

  const groups = new Map(
    loaded.groups.map((group) => [
      group.state,
      { ...group, items: [...group.items] },
    ]),
  );

  let added = 0;
  let addedHealthy = 0;

  for (const group of page.groups) {
    const fresh = group.items.filter((item) => !seen.has(item.id));

    if (fresh.length === 0) continue;

    for (const item of fresh) seen.add(item.id);

    added += fresh.length;

    if (group.healthy) addedHealthy += fresh.length;

    const existing = groups.get(group.state);

    if (existing) {
      existing.count += fresh.length;
      existing.items.push(...fresh);
    } else {
      groups.set(group.state, { ...group, count: fresh.length, items: fresh });
    }
  }

  const counts = loaded.countsComplete
    ? loaded
    : {
        total: loaded.total + added,
        healthy: loaded.healthy + addedHealthy,
        notHealthy: loaded.notHealthy + added - addedHealthy,
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
