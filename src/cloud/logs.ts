import { z } from "zod";
import { assertSafeId } from "../config.js";
import { USER_AGENT, parseJson } from "./client.js";

/** Hard ceilings. Callers can ask for less, never more. */
export const LOG_LIMITS = {
  maxLines: 500,
  maxSeconds: 10,
  maxBytes: 64 * 1024,
  maxLineChars: 2000,
  maxLookbackMinutes: 60,
} as const;

export interface LogEntry {
  timestamp: string;
  line: string;
  level?: string;
  nodeId?: string;
}

export type SnapshotStopReason =
  "line_limit" | "byte_limit" | "time_limit" | "stream_closed";

export interface LogSnapshot {
  jobId: string;
  nodeId?: string;
  since: string;
  entries: LogEntry[];
  stoppedBy: SnapshotStopReason;
  truncated: boolean;
}

/** The minimal socket surface the snapshot reader needs. */
export interface LogSocket {
  onMessage(handler: (data: string) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export type OpenLogSocket = (url: string, token: string) => Promise<LogSocket>;

export interface SnapshotRequest {
  endpoint: string;
  accessToken: string;
  jobId: string;
  nodeId?: string;
  lookbackMinutes?: number;
  maxLines?: number;
  maxSeconds?: number;
  now?: number;
}

/**
 * Reads a bounded snapshot from the orchestrator's live log WebSocket: it
 * replays from `lookbackMinutes` ago, collects until a line, byte, or time cap
 * is reached, then closes the socket. The model never sees an open stream.
 */
export async function readLogSnapshot(
  request: SnapshotRequest,
  openSocket: OpenLogSocket = openWorkerSocket,
): Promise<LogSnapshot> {
  const jobId = assertSafeId(request.jobId, "Job ID");

  const nodeId =
    request.nodeId === undefined
      ? undefined
      : assertSafeId(request.nodeId, "Node ID");

  const maxLines = clamp(request.maxLines ?? 100, 1, LOG_LIMITS.maxLines);
  const maxSeconds = clamp(request.maxSeconds ?? 5, 1, LOG_LIMITS.maxSeconds);

  const lookback = clamp(
    request.lookbackMinutes ?? 15,
    1,
    LOG_LIMITS.maxLookbackMinutes,
  );

  const sinceMs = (request.now ?? Date.now()) - lookback * 60_000;

  const params = new URLSearchParams({
    query: `{service_name="expanso-edge"} | pipeline_id = "${jobId}"`,
    start: `${BigInt(sinceMs) * 1_000_000n}`,
  });

  if (nodeId !== undefined) params.set("node_id", nodeId);
  const url = `https://${request.endpoint}/api/v1/jobs/${encodeURIComponent(jobId)}/logs?${params.toString()}`;

  const socket = await openSocket(url, request.accessToken);
  const entries: LogEntry[] = [];
  let bytes = 0;

  const stoppedBy = await new Promise<SnapshotStopReason>((resolve) => {
    let settled = false;

    const finish = (reason: SnapshotStopReason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(reason);
    };

    const timer = setTimeout(() => finish("time_limit"), maxSeconds * 1000);
    socket.onClose(() => finish("stream_closed"));
    socket.onMessage((data) => {
      if (settled) return;

      for (const entry of parseLokiFrame(data)) {
        const size = entry.line.length + entry.timestamp.length;

        if (bytes + size > LOG_LIMITS.maxBytes) {
          finish("byte_limit");

          return;
        }

        bytes += size;
        entries.push(entry);

        if (entries.length >= maxLines) {
          finish("line_limit");

          return;
        }
      }
    });
  });

  return {
    jobId,
    nodeId,
    since: new Date(sinceMs).toISOString(),
    entries,
    stoppedBy,
    truncated: stoppedBy === "line_limit" || stoppedBy === "byte_limit",
  };
}

/** Parses one Loki push frame: {streams: [{stream: {...}, values: [[ns, line]]}]}. */
export function parseLokiFrame(data: string): LogEntry[] {
  const frame = parseJson(data, LokiFrameSchema);

  if (!frame.success) return [];

  const entries: LogEntry[] = [];

  for (const stream of frame.data.streams) {
    const labels = stream.stream ?? {};

    for (const [timestamp, line] of stream.values) {
      entries.push({
        timestamp: nanosToIso(timestamp),
        line:
          line.length > LOG_LIMITS.maxLineChars
            ? `${line.slice(0, LOG_LIMITS.maxLineChars)}…`
            : line,
        level: labels.level ?? labels.detected_level,
        nodeId: labels.node_id,
      });
    }
  }

  return entries;
}

// Labels are free-form; only string labels are kept.
const LokiFrameSchema = z.object({
  streams: z.array(
    z.object({
      stream: z
        .record(z.string(), z.unknown())
        .transform((labels) => {
          const kept: Partial<Record<string, string>> = {};

          for (const [key, value] of Object.entries(labels)) {
            if (z.string().safeParse(value).success) kept[key] = String(value);
          }

          return kept;
        })
        .optional(),
      values: z.array(z.unknown()).transform((values) =>
        values.flatMap((value) => {
          const pair = LokiValueSchema.safeParse(value);

          return pair.success ? [pair.data] : [];
        }),
      ),
    }),
  ),
});

const LokiValueSchema = z.tuple([z.string(), z.string()]).rest(z.unknown());

function nanosToIso(nanos: string): string {
  const millis = Number(nanos.slice(0, 13));

  return Number.isFinite(millis) && nanos.length >= 13
    ? new Date(millis).toISOString()
    : nanos;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;

  return Math.min(Math.max(Math.floor(value), min), max);
}

/** Opens an outbound WebSocket from a Worker with a bearer token header. */
export const openWorkerSocket: OpenLogSocket = async (url, token) => {
  const response = await fetch(url, {
    headers: {
      Upgrade: "websocket",
      Authorization: `Bearer ${token}`,
      "User-Agent": USER_AGENT,
    },
  });

  const ws = response.webSocket;

  if (!ws) {
    throw new Error(
      `The log stream could not be opened (HTTP ${response.status}).`,
    );
  }

  ws.accept();

  return {
    onMessage: (handler) =>
      ws.addEventListener("message", (event) => {
        if (!(event.data instanceof ArrayBuffer)) handler(event.data);
      }),
    onClose: (handler) => {
      ws.addEventListener("close", handler);
      ws.addEventListener("error", handler);
    },
    close: () => {
      try {
        ws.close(1000, "snapshot complete");
      } catch {
        // Already closed.
      }
    },
  };
};
