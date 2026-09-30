import { describe, expect, it } from "vitest";
import { lineDiff, MAX_DIFF_CHARS } from "../src/mcp/diff.js";

const numbered = (count: number) =>
  Array.from({ length: count }, (_, index) => `line ${index + 1}`);

describe("lineDiff", () => {
  it("returns no text when nothing changed", () => {
    expect(lineDiff("a\nb\nc\n", "a\nb\nc\n")).toEqual({
      text: "",
      added: 0,
      removed: 0,
      truncated: false,
    });
  });

  it("treats CRLF and a trailing newline as the same text", () => {
    expect(lineDiff("a\r\nb\r\n", "a\nb").text).toBe("");
  });

  it("marks a replaced line as one removal and one addition", () => {
    const diff = lineDiff("a\nb\nc", "a\nx\nc");

    expect(diff.text).toBe("  a\n- b\n+ x\n  c");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
  });

  it("counts added and removed lines separately", () => {
    const diff = lineDiff("a\nb\nc\nd", "a\nc\nd\ne\nf");

    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
  });

  it("keeps two lines of context and marks skipped lines with an ellipsis", () => {
    const before = numbered(12);
    const after = [...before];

    after[1] = "changed 2";
    after[10] = "changed 11";

    const diff = lineDiff(before.join("\n"), after.join("\n"));

    expect(diff.text.split("\n")).toEqual([
      "  line 1",
      "- line 2",
      "+ changed 2",
      "  line 3",
      "  line 4",
      "…",
      "  line 9",
      "  line 10",
      "- line 11",
      "+ changed 11",
      "  line 12",
    ]);
  });

  it("does not open or close with an ellipsis around a single change", () => {
    const before = numbered(12);
    const after = [...before];

    after[5] = "changed 6";

    const lines = lineDiff(before.join("\n"), after.join("\n")).text.split(
      "\n",
    );

    expect(lines).toEqual([
      "  line 4",
      "  line 5",
      "- line 6",
      "+ changed 6",
      "  line 7",
      "  line 8",
    ]);
  });

  it("shows every line as added when creating from nothing", () => {
    const diff = lineDiff("", "name: p\ntype: pipeline\n");

    expect(diff).toEqual({
      text: "+ name: p\n+ type: pipeline",
      added: 2,
      removed: 0,
      truncated: false,
    });
  });

  it("shows every line as removed when the new text is empty", () => {
    const diff = lineDiff("a\nb", "");

    expect(diff.text).toBe("- a\n- b");
    expect(diff.removed).toBe(2);
  });

  it("cuts the text to MAX_DIFF_CHARS and says so", () => {
    const long = Array.from({ length: 200 }, (_, index) =>
      `${index}`.padEnd(80, "x"),
    ).join("\n");

    const diff = lineDiff("", long);

    expect(diff.truncated).toBe(true);
    expect(diff.text).toHaveLength(MAX_DIFF_CHARS);
    expect(diff.added).toBe(200);
  });

  it("does not flag a diff that fits", () => {
    expect(lineDiff("a", "b").truncated).toBe(false);
  });
});
