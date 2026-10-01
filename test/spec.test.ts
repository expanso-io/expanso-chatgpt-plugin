import { describe, expect, it } from "vitest";
import type { JobSpec, JsonObject } from "../src/cloud/types.js";
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
      {
        queue: "audit",
        url: "https://operator:fixture-url-pass@broker.example.com/queue",
      },
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
        { queue: "audit", url: REDACTED },
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
  const kafka = (brokers: string[], topic: string, password: string) => ({
    kafka_franz: {
      seed_brokers: brokers,
      topic,
      sasl: [{ mechanism: "PLAIN", username: "svc", password }],
    },
  });

  const pipeline = (output: JsonObject, mapping = "root = this"): JobSpec => ({
    name: "sink",
    count: 2,
    config: {
      input: { http_server: { path: "/ingest" } },
      pipeline: { processors: [{ mapping }] },
      output,
    },
  });

  const broker = (outputs: JsonObject[]): JobSpec => ({
    config: { output: { broker: { pattern: "fan_out", outputs } } },
  });

  const current = pipeline(kafka(["broker.corp:9092"], "events", "real-pw"));

  it("round-trips a redacted spec to the original", () => {
    expect(restoreRedacted(redactSpec(SPEC), SPEC)).toEqual(SPEC);
    expect(restoreRedacted(redactSpec(current), current)).toEqual(current);
  });

  it("keeps an unchanged component's secrets when another component is edited", () => {
    const edited = {
      ...pipeline(
        kafka(["broker.corp:9092"], "events", REDACTED),
        "root = this.lowercase()",
      ),
      count: 5,
    };

    expect(restoreRedacted(edited, current)).toEqual({
      ...pipeline(
        kafka(["broker.corp:9092"], "events", "real-pw"),
        "root = this.lowercase()",
      ),
      count: 5,
    });
  });

  it("refuses a kept secret when the component's brokers changed", () => {
    expect(() =>
      restoreRedacted(
        pipeline(kafka(["evil:9092"], "events", REDACTED)),
        current,
      ),
    ).toThrow(
      "config.output.kafka_franz holds a [redacted] value, but other fields in config.output.kafka_franz changed, so its secrets could go somewhere new. Put the real secrets for config.output.kafka_franz in the spec.",
    );
  });

  it("refuses a kept secret when any other field of its component changed", () => {
    expect(() =>
      restoreRedacted(
        pipeline(kafka(["broker.corp:9092"], "alerts", REDACTED)),
        current,
      ),
    ).toThrow(/^config\.output\.kafka_franz holds a \[redacted\] value/);

    const http = (count: number, authorization: string) => ({
      http_client: {
        url: "https://ingest.corp",
        headers: { Authorization: authorization },
        batching: { count },
      },
    });

    expect(() =>
      restoreRedacted(
        pipeline(http(50, REDACTED)),
        pipeline(http(10, "Bearer real")),
      ),
    ).toThrow(/^config\.output\.http_client holds a \[redacted\] value/);
  });

  it("counts a new value under a credential-looking key as a change", () => {
    const sql = (password: string, token: string) =>
      pipeline({ sql: { host: "db-1", password, token } });

    expect(() =>
      restoreRedacted(sql(REDACTED, "new-token"), sql("real-pw", "old-token")),
    ).toThrow(/^config\.output\.sql holds a \[redacted\] value/);

    expect(
      restoreRedacted(sql(REDACTED, REDACTED), sql("real-pw", "old-token")),
    ).toEqual(sql("real-pw", "old-token"));
  });

  it("refuses a kept client secret when the oauth2 token_url changed", () => {
    const http = (tokenUrl: string, secret: string) =>
      pipeline({
        http_client: {
          url: "https://ingest.corp",
          oauth2: {
            enabled: true,
            client_key: "id",
            client_secret: secret,
            token_url: tokenUrl,
          },
        },
      });

    const original = http("https://idp.corp/token", "real-secret");

    expect(() =>
      restoreRedacted(
        http("https://attacker.example/token", REDACTED),
        original,
      ),
    ).toThrow(/^config\.output\.http_client holds a \[redacted\] value/);

    expect(
      restoreRedacted(http("https://idp.corp/token", REDACTED), original),
    ).toEqual(original);
  });

  it("refuses a kept secret when a URL with embedded credentials changed", () => {
    const http = (url: string, authorization: string) =>
      pipeline({
        http_client: { url, headers: { Authorization: authorization } },
      });

    expect(() =>
      restoreRedacted(
        http("https://x:y@attacker.example", REDACTED),
        http("https://u:p@ingest.corp", "Bearer real"),
      ),
    ).toThrow(/^config\.output\.http_client holds a \[redacted\] value/);
  });

  it("keeps a top-level secret outside config", () => {
    expect(
      restoreRedacted(
        { name: "renamed", password: REDACTED },
        { name: "p", password: "real" },
      ),
    ).toEqual({ name: "renamed", password: "real" });
  });

  it("refuses a redacted value with nothing to restore", () => {
    expect(() => restoreRedacted({ password: REDACTED })).toThrow(
      "password holds a [redacted] value, but the job has no password to keep it from. Put the real value in the spec, or leave the field out.",
    );

    expect(() =>
      restoreRedacted(
        { config: { output: { sql: { password: REDACTED } } } },
        { config: { output: { http: { url: "x" } } } },
      ),
    ).toThrow(/^config\.output\.sql holds a \[redacted\] value/);
  });

  it("follows labelled items of one type to wherever they moved", () => {
    const output = (label: string, url: string, password: string) => ({
      label,
      http: { url, password },
    });

    expect(
      restoreRedacted(
        broker([
          output("b", "https://b.example.com", REDACTED),
          output("a", "https://a.example.com", REDACTED),
        ]),
        broker([
          output("a", "https://a.example.com", "pw-a"),
          output("b", "https://b.example.com", "pw-b"),
        ]),
      ),
    ).toEqual(
      broker([
        output("b", "https://b.example.com", "pw-b"),
        output("a", "https://a.example.com", "pw-a"),
      ]),
    );

    expect(() =>
      restoreRedacted(
        broker([output("a", "https://attacker.example", REDACTED)]),
        broker([output("a", "https://a.example.com", "pw-a")]),
      ),
    ).toThrow(
      /^config\.output\.broker\.outputs\[0\] holds a \[redacted\] value, but other fields/,
    );
  });

  it("follows the only item of a type to wherever it moved", () => {
    const sql = (password: string) => ({ sql: { host: "db-1", password } });

    expect(
      restoreRedacted(
        broker([sql(REDACTED), kafka(["k:9092"], "events", REDACTED)]),
        broker([kafka(["k:9092"], "events", "kafka-pw"), sql("sql-pw")]),
      ),
    ).toEqual(broker([sql("sql-pw"), kafka(["k:9092"], "events", "kafka-pw")]));
  });

  it("refuses to swap credentials between reordered items of one type", () => {
    const http = (url: string, password: string) => ({
      http: { url, password },
    });

    const original = broker([
      http("https://a.example.com", "pw-a"),
      http("https://b.example.com", "pw-b"),
    ]);

    expect(() =>
      restoreRedacted(
        broker([
          http("https://b.example.com", REDACTED),
          http("https://a.example.com", REDACTED),
        ]),
        original,
      ),
    ).toThrow(/^config\.output\.broker\.outputs\[0\] holds a \[redacted\]/);

    expect(restoreRedacted(redactSpec(original), original)).toEqual(original);
  });

  it("refuses a named item that is not in the current list", () => {
    expect(() =>
      restoreRedacted(
        broker([{ name: "c", http: { password: REDACTED } }]),
        broker([{ name: "a", http: { password: "pw-a" } }]),
      ),
    ).toThrow(
      /^config\.output\.broker\.outputs\[0\] holds a \[redacted\] value, but it no longer matches/,
    );
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
