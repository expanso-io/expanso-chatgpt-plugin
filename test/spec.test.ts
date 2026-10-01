import { describe, expect, it } from "vitest";
import type { JobSpec } from "../src/cloud/types.js";
import {
  parseSpecText,
  REDACTED,
  redactForDiff,
  redactSpec,
  restoreRedacted,
  selectorOf,
  SpecError,
  specName,
} from "../src/mcp/spec.js";

const SPEC: JobSpec = {
  name: "telemetry",
  type: "pipeline",
  count: 3,
  labels: { env: "prod" },
  endpoint: "https://collector.example.com/ingest",
  password: "fixture-password",
  config: {
    input: {
      api_key: "fixture-api-key",
      token: "fixture-token",
      connection_string: "Server=db;Password=fixture-conn",
      empty_secret: "",
    },
    outputs: [
      { password: "fixture-output-password", topic: "events" },
      { url: "https://operator:fixture-url-pass@broker.example.com/queue" },
      { url: "postgres://operator@db.example.com/metrics" },
    ],
    tokens: ["fixture-token-a", "fixture-token-b"],
  },
};

const SECRETS = [
  "fixture-password",
  "fixture-api-key",
  "fixture-token",
  "fixture-conn",
  "fixture-output-password",
  "fixture-url-pass",
  "fixture-token-a",
  "fixture-token-b",
];

describe("parseSpecText", () => {
  it("reads YAML", () => {
    expect(
      parseSpecText("name: telemetry\ntype: pipeline\nconfig:\n  input: x\n"),
    ).toEqual({ name: "telemetry", type: "pipeline", config: { input: "x" } });
  });

  it("reads JSON", () => {
    expect(parseSpecText('{"name": "telemetry", "count": 2}')).toEqual({
      name: "telemetry",
      count: 2,
    });
  });

  it("unwraps a spec given as {spec: {...}}", () => {
    expect(parseSpecText("spec:\n  name: telemetry\n")).toEqual({
      name: "telemetry",
    });
  });

  it("keeps a top-level spec field when other fields sit beside it", () => {
    expect(parseSpecText("name: outer\nspec:\n  name: inner\n")).toEqual({
      name: "outer",
      spec: { name: "inner" },
    });
  });

  it("rejects text that is not YAML", () => {
    expect(() => parseSpecText("name: [unclosed")).toThrow(SpecError);
    expect(() => parseSpecText("name: [unclosed")).toThrow(
      /not valid YAML or JSON/,
    );
  });

  it("rejects a document that is not a mapping", () => {
    expect(() => parseSpecText("- a\n- b\n")).toThrow(
      "The spec must be a mapping of fields.",
    );

    expect(() => parseSpecText("just words")).toThrow(SpecError);
  });

  it("rejects text past the size limit, naming what was read", () => {
    expect(() => parseSpecText("a".repeat(200_001), "The new spec")).toThrow(
      "The new spec is longer than 200000 characters.",
    );
  });
});

describe("redactSpec", () => {
  it("hides values under credential-looking keys and URLs with passwords", () => {
    const redacted = redactSpec(SPEC);
    const text = JSON.stringify(redacted);

    for (const secret of SECRETS) expect(text).not.toContain(secret);

    expect(redacted.password).toBe(REDACTED);

    expect(redacted.config).toEqual({
      input: {
        api_key: REDACTED,
        token: REDACTED,
        connection_string: REDACTED,
        empty_secret: "",
      },
      outputs: [
        { password: REDACTED, topic: "events" },
        { url: REDACTED },
        { url: "postgres://operator@db.example.com/metrics" },
      ],
      tokens: [REDACTED, REDACTED],
    });
  });

  it("hides everything under a credential-looking key, however deep", () => {
    const redacted = redactSpec({
      password: { value: "hunter2-nested" },
      credentials: { user: "svc", key: { pem: "BEGIN-fixture" } },
    });

    expect(JSON.stringify(redacted)).not.toMatch(/hunter2|svc|BEGIN/);
    expect(redacted).toEqual({
      password: { value: REDACTED },
      credentials: { user: REDACTED, key: { pem: REDACTED } },
    });
  });

  it("leaves ordinary values alone", () => {
    const redacted = redactSpec(SPEC);

    expect(redacted.name).toBe("telemetry");
    expect(redacted.type).toBe("pipeline");
    expect(redacted.count).toBe(3);
    expect(redacted.labels).toEqual({ env: "prod" });
    expect(redacted.endpoint).toBe("https://collector.example.com/ingest");
  });

  it("does not change the spec it was given", () => {
    const copy = structuredClone(SPEC);

    redactSpec(SPEC);

    expect(SPEC).toEqual(copy);
  });
});

describe("redactForDiff", () => {
  it("gives different markers to different secrets and equal markers to equal ones", () => {
    const first = redactForDiff({ password: "alpha-secret", token: "same" });
    const second = redactForDiff({ password: "bravo-secret", token: "same" });

    expect(first.password).toMatch(/^\[redacted [0-9a-f]{4}\]$/);
    expect(first.password).not.toBe(second.password);
    expect(first.token).toBe(second.token);
  });

  it("never contains the secret itself", () => {
    const text = JSON.stringify(redactForDiff(SPEC));

    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe("restoreRedacted", () => {
  it("puts current values back at the same path in objects and arrays", () => {
    const next: JobSpec = {
      name: "telemetry",
      password: REDACTED,
      config: {
        outputs: [{ password: REDACTED, topic: "new-topic" }, { url: "x" }],
        tokens: [REDACTED, "fresh-token"],
      },
    };

    expect(restoreRedacted(next, SPEC)).toEqual({
      name: "telemetry",
      password: "fixture-password",
      config: {
        outputs: [
          { password: "fixture-output-password", topic: "new-topic" },
          { url: "x" },
        ],
        tokens: ["fixture-token-a", "fresh-token"],
      },
    });
  });

  it("round-trips a redacted spec to the original", () => {
    expect(restoreRedacted(redactSpec(SPEC), SPEC)).toEqual(SPEC);
  });

  it("refuses a redacted value with nothing to restore", () => {
    expect(() => restoreRedacted({ password: REDACTED })).toThrow(SpecError);

    expect(() =>
      restoreRedacted(
        { config: { outputs: [{}, { password: REDACTED }] } },
        { config: { outputs: [{ password: "only-first" }] } },
      ),
    ).toThrow(/^config\.outputs\[1\]\.password is \[redacted\]/);
  });

  it("keeps a list item's credential when a sibling field is edited", () => {
    const current: JobSpec = {
      outputs: [{ kafka: { topic: "events", sasl: { password: "kafka-pw" } } }],
    };

    const edited: JobSpec = {
      outputs: [{ kafka: { topic: "alerts", sasl: { password: REDACTED } } }],
    };

    expect(restoreRedacted(edited, current)).toEqual({
      outputs: [{ kafka: { topic: "alerts", sasl: { password: "kafka-pw" } } }],
    });
  });

  it("refuses to move credentials between reordered list items", () => {
    const current: JobSpec = {
      outputs: [
        { kafka: { topic: "events", password: "kafka-pw" } },
        { sql: { host: "db-1", password: "sql-pw" } },
      ],
    };

    const reordered: JobSpec = {
      outputs: [
        { sql: { host: "db-1", password: REDACTED } },
        { kafka: { topic: "events", password: REDACTED } },
      ],
    };

    expect(() => restoreRedacted(reordered, current)).toThrow(
      /^outputs\[0\]\.sql\.password is \[redacted\]/,
    );

    expect(restoreRedacted(redactSpec(current), current)).toEqual(current);
  });

  it("follows a named list item to wherever it moved", () => {
    const current: JobSpec = {
      outputs: [
        { name: "a", http: { url: "https://a.example.com", password: "pw-a" } },
        { name: "b", http: { url: "https://b.example.com", password: "pw-b" } },
      ],
    };

    const reordered: JobSpec = {
      outputs: [
        {
          name: "b",
          http: { url: "https://b.example.com", password: REDACTED },
        },
        {
          name: "a",
          http: { url: "https://a.example.com", password: REDACTED },
        },
      ],
    };

    expect(restoreRedacted(reordered, current)).toEqual({
      outputs: [
        { name: "b", http: { url: "https://b.example.com", password: "pw-b" } },
        { name: "a", http: { url: "https://a.example.com", password: "pw-a" } },
      ],
    });

    expect(() =>
      restoreRedacted(
        { outputs: [{ name: "c", http: { password: REDACTED } }] },
        current,
      ),
    ).toThrow(/^outputs\[0\]\.http\.password is \[redacted\]/);
  });

  it("refuses when the current value is itself the placeholder", () => {
    expect(() =>
      restoreRedacted({ token: REDACTED }, { token: REDACTED }),
    ).toThrow(SpecError);
  });

  it("leaves a spec without placeholders unchanged", () => {
    const spec: JobSpec = { name: "p", password: "typed-in" };

    expect(restoreRedacted(spec, SPEC)).toEqual(spec);
  });
});

describe("selectorOf", () => {
  it("reads node ids", () => {
    expect(
      selectorOf({ selector: { match_ids: ["node-a", "node-b"] } }),
    ).toEqual({
      matchIds: ["node-a", "node-b"],
      labels: [],
      text: "node node-a or node-b",
    });
  });

  it("reads label maps as key=value expressions", () => {
    expect(
      selectorOf({ selector: { match_labels: { env: "prod", tier: 2 } } }),
    ).toEqual({
      matchIds: [],
      labels: ["env=prod", "tier=2"],
      text: "env=prod and tier=2",
    });
  });

  it("ANDs ids, labels, and expressions together", () => {
    const selector = selectorOf({
      selector: {
        match_ids: ["node-a"],
        match_labels: { env: "prod" },
        match_expressions: ["zone in (a,b)"],
      },
    });

    expect(selector.labels).toEqual(["env=prod", "zone in (a,b)"]);
    expect(selector.text).toBe("node node-a and env=prod and zone in (a,b)");
  });

  it("says every node when there is no selector", () => {
    const none = {
      matchIds: [],
      labels: [],
      text: "every node (no selector)",
    };

    expect(selectorOf({ name: "p" })).toEqual(none);
    expect(selectorOf({ selector: "all" })).toEqual(none);
    expect(selectorOf({ selector: { match_ids: "node-a" } })).toEqual(none);
  });
});

describe("specName", () => {
  it("returns the trimmed name", () => {
    expect(specName({ name: "  telemetry " })).toBe("telemetry");
  });

  it("returns undefined for a missing, blank, or non-text name", () => {
    expect(specName({})).toBeUndefined();
    expect(specName({ name: "   " })).toBeUndefined();
    expect(specName({ name: 3 })).toBeUndefined();
  });
});
