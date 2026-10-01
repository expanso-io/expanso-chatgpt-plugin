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
// reach the model. On the way back, every REDACTED left in place is filled
// from the job's current spec at the same path, so an edit keeps the
// credentials it never saw.

export const REDACTED = "[redacted]";

/** Keys whose values are treated as credentials. */
const SECRET_KEY =
  /(pass(word|wd|phrase)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?key|credential|auth(orization)?|bearer|signature|sas|dsn|connection[_-]?string|cookie|session)/i;

/** A URL carrying user:password credentials. */
const URL_CREDENTIALS = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;

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
 * Replaces every REDACTED in `next` with the value at the same path in
 * `current`. A REDACTED with nothing to restore is an error: the spec would
 * otherwise deploy the placeholder itself.
 */
export function restoreRedacted(next: JobSpec, current?: JobSpec): JobSpec {
  return restoreObject(next, current, "");
}

function restoreObject(
  next: JobSpec,
  current: JobSpec | undefined,
  path: string,
): JobSpec {
  return Object.fromEntries(
    Object.entries(next).map(([name, item]) => [
      name,
      restoreAt(item, current?.[name], path ? `${path}.${name}` : name),
    ]),
  );
}

function restoreAt(
  value: JsonValue,
  current: JsonValue | undefined,
  path: string,
): JsonValue {
  if (value === REDACTED) {
    if (current === undefined || current === REDACTED) {
      throw new SpecError(
        `${path} is ${REDACTED}, but the job has no matching value there to keep. Put the real value in the spec, or leave the field out.`,
      );
    }

    return current;
  }

  if (isJsonArray(value)) {
    const items = isJsonArray(current) ? current : [];

    return value.map((item, index) => {
      const itemPath = `${path}[${index}]`;

      return restoreAt(
        item,
        matchingItem(item, index, value, items, itemPath),
        itemPath,
      );
    });
  }

  if (isJsonObject(value)) {
    return restoreObject(
      value,
      isJsonObject(current) ? current : undefined,
      path,
    );
  }

  return value;
}

/**
 * The current list item an edited one with placeholders stands for: the item
 * with the same name or label; else the only item of its component type
 * (kafka, sql, ...); else the same-type item at its position, provided every
 * value beside a placeholder is unchanged. Anything else is refused.
 */
function matchingItem(
  item: JsonValue,
  index: number,
  edited: JsonValue[],
  items: JsonValue[],
  path: string,
): JsonValue | undefined {
  if (!isJsonObject(item)) return items[index];

  if (!hasPlaceholder(item)) return undefined;

  const identity = itemIdentity(item);

  const match =
    identity !== undefined
      ? items.find(
          (candidate) =>
            isJsonObject(candidate) && itemIdentity(candidate) === identity,
        )
      : (onlyOfType(item, edited, items) ?? samePlace(item, items[index]));

  if (match === undefined) {
    throw new SpecError(
      `${path} holds a ${REDACTED} value, but it no longer matches one item in the job's current list. Put the real value in the spec, or give the item a name or label.`,
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
  return isJsonObject(current) &&
    componentKeys(current) === componentKeys(item) &&
    placeholdersGuarded(item, current, false)
    ? current
    : undefined;
}

/**
 * Whether every placeholder has at least one visible value beside it or
 * beside one of its ancestors within the item, and every such value is
 * unchanged from the current item.
 */
function placeholdersGuarded(
  next: JsonValue,
  current: JsonValue | undefined,
  guarded: boolean,
): boolean {
  if (next === REDACTED) return guarded;

  if (!hasPlaceholder(next)) return true;

  if (isJsonArray(next)) {
    return next.every((item, index) =>
      placeholdersGuarded(
        item,
        isJsonArray(current) ? current[index] : undefined,
        guarded,
      ),
    );
  }

  if (!isJsonObject(next)) return true;

  const before: JsonObject = isJsonObject(current) ? current : {};
  const entries = Object.entries(next);
  const visible = entries.filter(([, value]) => !hasPlaceholder(value));

  const unchanged = visible.every(([key, value]) => {
    const old = before[key];

    return old !== undefined && canonicalJson(value) === canonicalJson(old);
  });

  const here = guarded || visible.length > 0;

  return (
    unchanged &&
    entries.every(([key, value]) =>
      placeholdersGuarded(value, before[key], here),
    )
  );
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
