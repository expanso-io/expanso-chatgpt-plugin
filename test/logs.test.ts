import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOG_LIMITS,
  parseLokiFrame,
  readLogSnapshot,
  type LogSocket,
  type OpenLogSocket,
} from "../src/cloud/logs.js";
import { fixture } from "./helpers.js";

/** A socket the test drives by hand. */
function scriptedSocket() {
  let onMessage: (data: string) => void = () => {};

  let onClose: () => void = () => {};

  const state = { closed: false, url: "", token: "" };

  const socket: LogSocket = {
    onMessage: (handler) => (onMessage = handler),
    onClose: (handler) => (onClose = handler),
    close: () => {
      state.closed = true;
    },
  };

  const open: OpenLogSocket = async (url, token) => {
    state.url = url;
    state.token = token;

    return socket;
  };

  return {
    open,
    state,
    send: (data: string) => onMessage(data),
    remoteClose: () => onClose(),
  };
}

function frame(lines: string[], start = 1_790_795_940_000): string {
  return JSON.stringify({
    streams: [
      {
        stream: { node_id: "node-edge-02", level: "info" },
        values: lines.map((line, index) => [`${start + index}000000`, line]),
      },
    ],
  });
}

const base = {
  endpoint: "ws1.us1.cloud.expanso.io:9010",
  accessToken: "jwt-fixture",
  jobId: "job-ingest-7f3a",
  now: 1_790_796_000_000,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("readLogSnapshot", () => {
  it("replays from the lookback window over the existing stream", async () => {
    const sock = scriptedSocket();

    const pending = readLogSnapshot(
      { ...base, nodeId: "node-edge-02", lookbackMinutes: 15, maxLines: 2 },
      sock.open,
    );

    await Promise.resolve();
    sock.send(fixture("log-frame.json"));
    const snapshot = await pending;

    const url = new URL(sock.state.url);
    expect(url.host).toBe(base.endpoint);
    expect(url.pathname).toBe("/api/v1/jobs/job-ingest-7f3a/logs");
    expect(url.searchParams.get("node_id")).toBe("node-edge-02");
    expect(url.searchParams.get("query")).toBe(
      '{service_name="expanso-edge"} | pipeline_id = "job-ingest-7f3a"',
    );
    expect(url.searchParams.get("start")).toBe(
      `${(base.now - 15 * 60_000) * 1_000_000}`,
    );
    expect(sock.state.token).toBe("jwt-fixture");

    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries[0]).toMatchObject({
      line: "output: dial tcp 10.0.0.5:9000: connection refused",
      level: "error",
      nodeId: "node-edge-02",
    });
    expect(snapshot.stoppedBy).toBe("line_limit");
    expect(snapshot.truncated).toBe(true);
    expect(sock.state.closed).toBe(true);
  });

  it("never returns more than the hard line cap, whatever is requested", async () => {
    const sock = scriptedSocket();
    const pending = readLogSnapshot({ ...base, maxLines: 10_000 }, sock.open);
    await Promise.resolve();

    for (let batch = 0; batch < 20; batch += 1) {
      sock.send(
        frame(Array.from({ length: 50 }, (_, i) => `line ${batch}-${i}`)),
      );
    }

    const snapshot = await pending;
    expect(snapshot.entries).toHaveLength(LOG_LIMITS.maxLines);
    expect(snapshot.stoppedBy).toBe("line_limit");
  });

  it("stops at the byte cap", async () => {
    const sock = scriptedSocket();
    const pending = readLogSnapshot({ ...base, maxLines: 500 }, sock.open);
    await Promise.resolve();
    const big = "x".repeat(LOG_LIMITS.maxLineChars + 500);
    sock.send(frame(Array.from({ length: 100 }, () => big)));
    const snapshot = await pending;
    expect(snapshot.stoppedBy).toBe("byte_limit");

    const bytes = snapshot.entries.reduce(
      (sum, entry) => sum + entry.line.length + entry.timestamp.length,
      0,
    );

    expect(bytes).toBeLessThanOrEqual(LOG_LIMITS.maxBytes);
    expect(snapshot.entries[0].line.length).toBe(LOG_LIMITS.maxLineChars + 1);
  });

  it("stops at the time cap and closes the socket", async () => {
    vi.useFakeTimers();
    const sock = scriptedSocket();
    const pending = readLogSnapshot({ ...base, maxSeconds: 60 }, sock.open);
    await vi.advanceTimersByTimeAsync(0);
    sock.send(frame(["only line"]));
    await vi.advanceTimersByTimeAsync(LOG_LIMITS.maxSeconds * 1000);
    const snapshot = await pending;
    expect(snapshot.stoppedBy).toBe("time_limit");
    expect(snapshot.entries).toHaveLength(1);
    expect(sock.state.closed).toBe(true);
  });

  it("returns what it has when the stream closes", async () => {
    const sock = scriptedSocket();
    const pending = readLogSnapshot(base, sock.open);
    await Promise.resolve();
    sock.send(frame(["a", "b"]));
    sock.remoteClose();
    const snapshot = await pending;
    expect(snapshot.stoppedBy).toBe("stream_closed");
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.entries.map((entry) => entry.line)).toEqual(["a", "b"]);
  });

  it("clamps lookback to the maximum window", async () => {
    const sock = scriptedSocket();

    const pending = readLogSnapshot(
      { ...base, lookbackMinutes: 10_000 },
      sock.open,
    );

    await Promise.resolve();
    sock.remoteClose();
    const snapshot = await pending;
    expect(Date.parse(snapshot.since)).toBe(
      base.now - LOG_LIMITS.maxLookbackMinutes * 60_000,
    );
  });

  it("rejects a job ID that could alter the log query", async () => {
    const sock = scriptedSocket();
    await expect(
      readLogSnapshot({ ...base, jobId: 'x" or 1=1' }, sock.open),
    ).rejects.toThrow(/unsupported characters/);
    expect(sock.state.url).toBe("");
  });
});

describe("parseLokiFrame", () => {
  it("ignores malformed frames and values", () => {
    expect(parseLokiFrame("not json")).toEqual([]);
    expect(
      parseLokiFrame(
        JSON.stringify({ streams: [{ values: [[1, 2], ["3"]] }] }),
      ),
    ).toEqual([]);
  });
});
