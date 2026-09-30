import type { TimeBucket } from "../../src/mcp/contracts.js";

// Small, dependency-free SVG charts. Each carries an aria-label that states
// the numbers it draws, so the chart is never the only place they appear.

const WIDTH = 320;

interface SparkProps {
  values: (number | null | undefined)[];
  label: string;
  height?: number;
  max?: number;
  tone?: "good" | "bad" | "none";
}

/** A line over time; gaps where there is no sample. */
export function Sparkline({
  values,
  label,
  height = 36,
  max,
  tone = "none",
}: SparkProps) {
  const known = values.filter((value): value is number => value != null);

  if (known.length === 0) {
    return <p className="empty">No samples yet.</p>;
  }

  const top = max ?? Math.max(...known, 1);
  const step = values.length > 1 ? WIDTH / (values.length - 1) : WIDTH;
  const y = (value: number) => height - 2 - (value / top) * (height - 4);

  let path = "";
  let pen = false;

  values.forEach((value, index) => {
    if (value == null) {
      pen = false;

      return;
    }

    path += `${pen ? "L" : "M"}${(index * step).toFixed(1)},${y(value).toFixed(1)} `;
    pen = true;
  });

  return (
    <svg
      className={`spark tone-${tone}`}
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

interface BarsProps {
  buckets: TimeBucket[];
  /** Keys stacked bottom to top, each with a tone. */
  series: { key: string; tone: "good" | "bad" | "warn" | "none" }[];
  label: string;
  height?: number;
}

/** Hourly bars, stacked by series. */
export function Bars({ buckets, series, label, height = 56 }: BarsProps) {
  const totals = buckets.map((bucket) =>
    series.reduce((sum, item) => sum + (bucket.counts[item.key] ?? 0), 0),
  );

  const top = Math.max(...totals, 1);
  const slot = WIDTH / Math.max(buckets.length, 1);
  const bar = Math.max(1, slot - 2);

  return (
    <svg
      className="bars"
      viewBox={`0 0 ${WIDTH} ${height}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      {buckets.map((bucket, index) => {
        let base = height;

        return series.map((item) => {
          const count = bucket.counts[item.key] ?? 0;

          if (count === 0) return null;

          const h = (count / top) * (height - 2);

          base -= h;

          return (
            <rect
              key={`${bucket.t}-${item.key}`}
              className={`tone-${item.tone}`}
              x={index * slot + 1}
              y={base}
              width={bar}
              height={h}
              fill="currentColor"
            >
              <title>{`${new Date(bucket.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: ${count} ${item.key}`}</title>
            </rect>
          );
        });
      })}
    </svg>
  );
}

/** Sum of every bucket's counts for the given keys. */
export function total(buckets: TimeBucket[], keys?: string[]): number {
  return buckets.reduce(
    (sum, bucket) =>
      sum +
      Object.entries(bucket.counts)
        .filter(([key]) => !keys || keys.includes(key))
        .reduce((inner, [, count]) => inner + count, 0),
    0,
  );
}
