import { parse as parseYaml, stringify as toYaml } from "yaml";
import { z } from "zod";
import {
  isJsonArray,
  isJsonObject,
  JobSpecSchema,
  jsonText,
  type JobSpec,
  type JsonObject,
  type JsonValue,
} from "../cloud/types.js";
import { canonicalJson } from "./confirm.js";

// Job specs cross the chat boundary in both directions. On the way out,
// values that look like credentials are replaced with REDACTED so they never
// reach the model. On the way back, a REDACTED left in place is filled from
// the job's current spec only when its component is otherwise unchanged (see
// restoreRedacted), so an edit keeps the credentials it never saw without
// sending them anywhere new.

export const REDACTED = "[redacted]";

/** Keys whose values are treated as credentials. */
const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|auth(orization)?|bearer|signature|sas|dsn|connection[_-]?string|cookie|session)/i;

/** A URL carrying user:password credentials. */
const URL_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

/** A whole value that only names an environment variable the edge node fills in. */
const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** Limits what a pasted spec may be, before anything parses it deeply. */
const MAX_SPEC_CHARS = 200_000;

/** A spec wrapped the way the CLI and API take it: {spec: {...}}. */
const WrappedSpecSchema = z.object({ spec: JobSpecSchema }).strict();

const NameSchema = z.string().trim().min(1);

const StringListSchema = z.array(z.string());

const LabelMapSchema = z.record(z.string(), z.json());

export class SpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecError";
  }
}

/** Parses a job spec written as YAML or JSON (JSON is valid YAML). */
export function parseSpecText(text: string, what = "The spec"): JobSpec {
  if (text.length > MAX_SPEC_CHARS) {
    throw new SpecError(`${what} is longer than ${MAX_SPEC_CHARS} characters.`);
  }

  let document: ReturnType<typeof parseYaml>;

  try {
    document = parseYaml(text, { maxAliasCount: 100 });
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : "";

    throw new SpecError(`${what} is not valid YAML or JSON: ${detail}`);
  }

  const wrapped = WrappedSpecSchema.safeParse(document);

  if (wrapped.success) return wrapped.data.spec;

  const spec = JobSpecSchema.safeParse(document);

  if (!spec.success) {
    throw new SpecError(`${what} must be a mapping of fields.`);
  }

  return spec.data;
}

export function specYaml(spec: JobSpec): string {
  return toYaml(spec, { lineWidth: 0, sortMapEntries: false });
}

/** A copy of the spec with credential-looking values replaced by REDACTED. */
export function redactSpec(spec: JobSpec): JobSpec {
  return redactObject(spec, () => REDACTED);
}

/**
 * Like redactSpec, but each marker carries a short fingerprint of the value,
 * so a diff still shows that a credential changed without showing either
 * value.
 */
export function redactForDiff(spec: JobSpec): JobSpec {
  return redactObject(
    spec,
    (secret) => `[redacted ${fnv1a(JSON.stringify(secret))}]`,
  );
}

type Marker = (secret: JsonValue) => string;

function redactObject(
  spec: JobSpec,
  marker: Marker,
  underSecret = false,
): JobSpec {
  return Object.fromEntries(
    Object.entries(spec).map(([name, item]) => [
      name,
      redactAt(item, underSecret || SECRET_KEY.test(name), marker),
    ]),
  );
}

/** Everything under a credential-looking key is hidden, however deep. */
function redactAt(
  value: JsonValue,
  secret: boolean,
  marker: Marker,
): JsonValue {
  if (isJsonArray(value)) {
    return value.map((item) => redactAt(item, secret, marker));
  }

  if (isJsonObject(value)) return redactObject(value, marker, secret);

  if (value === null || value === "") return value;

  if (ENV_REFERENCE.test(jsonText(value) ?? "")) return value;

  if (secret) return marker(value);

  if (URL_CREDENTIALS.test(jsonText(value) ?? "")) return marker(value);

  return value;
}

/** 16 bits of FNV-1a: enough to tell values apart, too little to recover one. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return ((hash ^ (hash >>> 16)) & 0xffff).toString(16).padStart(4, "0");
}

/**
 * Which parts of a spec are components: a key names a part to walk into, or
 * "list" for a list whose items are each a component. Any other key under a
 * walked part is a component in itself.
 */
interface Layout {
  [key: string]: Layout | "list";
}

const ROUTER: Layout = { inputs: "list", outputs: "list", cases: "list" };

const ENDPOINT: Layout = { broker: ROUTER, switch: ROUTER };

const SPEC_LAYOUT: Layout = {
  config: {
    input: ENDPOINT,
    output: ENDPOINT,
    pipeline: { processors: "list" },
    cache_resources: "list",
    rate_limit_resources: "list",
    input_resources: "list",
    output_resources: "list",
    processor_resources: "list",
  },
};

/**
 * Replaces every REDACTED in `next` with the value at the same path in
 * `current`. A secret is kept only when the component holding it (an input,
 * output, processor, cache, or resource; outside config, the top-level field)
 * is identical to the current one apart from its REDACTED placeholders. Any
 * other change to that component, a new credential included, could send the
 * secret somewhere new. Secrets never go through chat, so a refusal points at
 * Expanso Cloud's job editor (`consoleUrl`) or an environment variable
 * reference instead.
 */
export function restoreRedacted(
  next: JobSpec,
  current: JobSpec | undefined,
  consoleUrl: string,
): JobSpec {
  try {
    return restoreParts(next, current, "", SPEC_LAYOUT);
  } catch (error) {
    if (!(error instanceof SecretRefused)) throw error;

    throw new SpecError(
      `${error.message} Secrets never go through chat. Make this change in Expanso Cloud's job editor (${consoleUrl}), or replace the secret with an environment variable reference such as \${VAR_NAME}, which the edge node fills in.`,
    );
  }
}

/** Why a saved secret cannot be kept; restoreRedacted adds the remedy. */
class SecretRefused extends Error {}

function restoreParts(
  next: JsonObject,
  current: JsonValue | undefined,
  path: string,
  layout: Layout,
): JsonObject {
  const before: JsonObject = isJsonObject(current) ? current : {};

  return Object.fromEntries(
    Object.entries(next).map(([name, value]) => {
      const at = path ? `${path}.${name}` : name;
      const inner = Object.hasOwn(layout, name) ? layout[name] : undefined;

      if (inner === "list" && isJsonArray(value)) {
        return [name, restoreList(value, before[name], at)];
      }

      if (inner !== undefined && inner !== "list" && isJsonObject(value)) {
        return [name, restoreParts(value, before[name], at, inner)];
      }

      return [name, restoreComponent(value, before[name], at)];
    }),
  );
}

function restoreList(
  next: JsonValue[],
  current: JsonValue | undefined,
  path: string,
): JsonValue[] {
  const items = isJsonArray(current) ? current : [];

  return next.map((item, index) => {
    const at = `${path}[${index}]`;

    return hasPlaceholder(item)
      ? restoreComponent(item, matchingItem(item, index, next, items, at), at)
      : item;
  });
}

function restoreComponent(
  next: JsonValue,
  current: JsonValue | undefined,
  path: string,
): JsonValue {
  if (!hasPlaceholder(next)) return next;

  if (current === undefined) {
    throw new SecretRefused(
      `${path} holds a ${REDACTED} value, but the job has no saved ${path} to keep it from.`,
    );
  }

  if (!sameApartFromPlaceholders(next, current)) {
    throw new SecretRefused(
      `${path} holds a saved secret, and other fields in ${path} changed, so the secret could go somewhere new.`,
    );
  }

  return fill(next, current, path);
}

/**
 * Whether `next` equals `current` exactly, except where `next` holds REDACTED
 * and `current` has a value there to restore.
 */
function sameApartFromPlaceholders(
  next: JsonValue,
  current: JsonValue | undefined,
): boolean {
  if (next === REDACTED) return current !== undefined;

  if (isJsonArray(next)) {
    return (
      isJsonArray(current) &&
      current.length === next.length &&
      next.every((item, index) =>
        sameApartFromPlaceholders(item, current[index]),
      )
    );
  }

  if (isJsonObject(next)) {
    return (
      isJsonObject(current) &&
      componentKeys(current) === componentKeys(next) &&
      Object.entries(next).every(([name, value]) =>
        sameApartFromPlaceholders(value, current[name]),
      )
    );
  }

  return (
    current !== undefined && canonicalJson(next) === canonicalJson(current)
  );
}

/** Puts back each REDACTED from a current value of the same shape. */
function fill(
  next: JsonValue,
  current: JsonValue | undefined,
  path: string,
): JsonValue {
  if (next === REDACTED) {
    if (current === undefined || current === REDACTED) {
      throw new SecretRefused(
        `${path} is ${REDACTED}, but the job has no saved value there to keep.`,
      );
    }

    return current;
  }

  if (isJsonArray(next)) {
    const items = isJsonArray(current) ? current : [];

    return next.map((item, index) =>
      fill(item, items[index], `${path}[${index}]`),
    );
  }

  if (isJsonObject(next)) {
    const before: JsonObject = isJsonObject(current) ? current : {};

    return Object.fromEntries(
      Object.entries(next).map(([name, value]) => [
        name,
        fill(value, before[name], `${path}.${name}`),
      ]),
    );
  }

  return next;
}

/**
 * The current list item an edited one with placeholders stands for: the item
 * with the same name or label; else the only item of its component type
 * (kafka, sql, ...); else the same-type item at its position. Anything else
 * is refused.
 */
function matchingItem(
  item: JsonValue,
  index: number,
  edited: JsonValue[],
  items: JsonValue[],
  path: string,
): JsonValue | undefined {
  if (!isJsonObject(item)) return items[index];

  const identity = itemIdentity(item);

  const match =
    identity !== undefined
      ? items.find(
          (candidate) =>
            isJsonObject(candidate) && itemIdentity(candidate) === identity,
        )
      : (onlyOfType(item, edited, items) ?? samePlace(item, items[index]));

  if (match === undefined) {
    throw new SecretRefused(
      `${path} holds a ${REDACTED} value, but it no longer matches one item in the job's current list; a name or label on each item tells them apart.`,
    );
  }

  return match;
}

function onlyOfType(
  item: JsonObject,
  edited: JsonValue[],
  items: JsonValue[],
): JsonValue | undefined {
  const keys = componentKeys(item);
  const ofType = (value: JsonValue) =>
    isJsonObject(value) && componentKeys(value) === keys;

  const current = items.filter(ofType);

  return edited.filter(ofType).length === 1 && current.length === 1
    ? current[0]
    : undefined;
}

function samePlace(
  item: JsonObject,
  current: JsonValue | undefined,
): JsonValue | undefined {
  return isJsonObject(current) && componentKeys(current) === componentKeys(item)
    ? current
    : undefined;
}

function hasPlaceholder(value: JsonValue): boolean {
  if (value === REDACTED) return true;

  if (isJsonArray(value)) return value.some(hasPlaceholder);

  if (isJsonObject(value)) return Object.values(value).some(hasPlaceholder);

  return false;
}

function itemIdentity(item: JsonObject): string | undefined {
  return jsonText(item.name) ?? jsonText(item.label);
}

function componentKeys(item: JsonObject): string {
  return Object.keys(item).sort().join("\n");
}

export interface SelectorSummary {
  matchIds: string[];
  /** Label selector expressions, as GET /nodes?labels= takes them. */
  labels: string[];
  text: string;
}

/** Reads spec.selector as the orchestrator does: ids, labels, and expressions ANDed. */
export function selectorOf(spec: JobSpec): SelectorSummary {
  const selector = isJsonObject(spec.selector) ? spec.selector : {};
  const matchIds = strings(selector.match_ids);
  const labelMap = LabelMapSchema.safeParse(selector.match_labels);

  const matchLabels = labelMap.success
    ? Object.entries(labelMap.data).map(
        ([key, value]) => `${key}=${jsonText(value) ?? JSON.stringify(value)}`,
      )
    : [];

  const labels = [...matchLabels, ...strings(selector.match_expressions)];

  const parts = [
    ...(matchIds.length > 0 ? [`node ${matchIds.join(" or ")}`] : []),
    ...labels,
  ];

  return {
    matchIds,
    labels,
    text: parts.length > 0 ? parts.join(" and ") : "every node (no selector)",
  };
}

export function specName(spec: JobSpec): string | undefined {
  const name = NameSchema.safeParse(spec.name);

  return name.success ? name.data : undefined;
}

/** The spec's type, for example "pipeline". */
export function specKind(spec: JobSpec): string | undefined {
  return jsonText(spec.type);
}

function strings(value: JsonValue | undefined): string[] {
  const list = StringListSchema.safeParse(value);

  return list.success ? list.data : [];
}
