// A small line diff for confirm previews. Specs are short (a pipeline config
// is rarely more than a few hundred lines), so a plain LCS table is enough;
// inputs past MAX_DIFF_LINES skip the table and show a whole replacement.

const MAX_DIFF_LINES = 2000;

const CONTEXT_LINES = 2;

/** Longest diff text handed to the confirm step. */
export const MAX_DIFF_CHARS = 6000;

export interface LineDiff {
  /** Unified-style text: "+ " added, "- " removed, "  " context. */
  text: string;
  added: number;
  removed: number;
  /** True when the text was cut to MAX_DIFF_CHARS. */
  truncated: boolean;
}

type Op = { kind: " " | "+" | "-"; line: string };

export function lineDiff(before: string, after: string): LineDiff {
  const a = splitLines(before);
  const b = splitLines(after);

  const ops =
    a.length + b.length > MAX_DIFF_LINES
      ? [
          ...a.map((line) => ({ kind: "-" as const, line })),
          ...b.map((line) => ({ kind: "+" as const, line })),
        ]
      : lcsOps(a, b);

  const added = ops.filter((op) => op.kind === "+").length;
  const removed = ops.filter((op) => op.kind === "-").length;

  if (added === 0 && removed === 0) {
    return { text: "", added, removed, truncated: false };
  }

  const text = withContext(ops).join("\n");

  return {
    text: text.length > MAX_DIFF_CHARS ? text.slice(0, MAX_DIFF_CHARS) : text,
    added,
    removed,
    truncated: text.length > MAX_DIFF_CHARS,
  };
}

function splitLines(text: string): string[] {
  if (text === "") return [];

  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}

function lcsOps(a: string[], b: string[]): Op[] {
  // lengths[i][j] is the LCS length of a[i..] and b[j..].
  const lengths = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );

  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] });
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ kind: "-", line: a[i] });
      i += 1;
    } else {
      ops.push({ kind: "+", line: b[j] });
      j += 1;
    }
  }

  for (; i < a.length; i += 1) ops.push({ kind: "-", line: a[i] });

  for (; j < b.length; j += 1) ops.push({ kind: "+", line: b[j] });

  return ops;
}

/** Keeps changed lines plus CONTEXT_LINES around them; gaps become "…". */
function withContext(ops: Op[]): string[] {
  const keep = new Array<boolean>(ops.length).fill(false);

  ops.forEach((op, index) => {
    if (op.kind === " ") return;

    const from = Math.max(0, index - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, index + CONTEXT_LINES);

    for (let k = from; k <= to; k += 1) keep[k] = true;
  });

  const lines: string[] = [];
  let skipped = false;

  ops.forEach((op, index) => {
    if (!keep[index]) {
      skipped = true;

      return;
    }

    if (skipped && lines.length > 0) lines.push("…");

    skipped = false;
    lines.push(`${op.kind} ${op.line}`);
  });

  return lines;
}
