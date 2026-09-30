import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url).href);

/** Raw text of a recorded response in test/fixtures. */
export function fixture(name: string): string {
  return readFileSync(`${FIXTURES}${name}`, "utf8");
}

export interface RecordedRequest {
  url: URL;
  method: string;
  headers: Headers;
}

export type Route = (request: RecordedRequest) => Response;

/** Serves a recorded fixture as a JSON response. */
export const serve =
  (name: string): Route =>
  () =>
    new Response(fixture(name), {
      headers: { "Content-Type": "application/json" },
    });

/**
 * Serves a Cloud token exchange response. The token is assembled here from a
 * claims fixture so no token-shaped string is stored in the repository.
 */
export const serveToken =
  (claimsFixture: string): Route =>
  () =>
    Response.json({
      access_token: fixtureToken(claimsFixture),
      token_type: "Bearer",
      expires_in: 3600,
    });

/** An unsigned, token-shaped string carrying the claims in a fixture. */
export function fixtureToken(claimsFixture: string): string {
  const encode = (text: string) => Buffer.from(text).toString("base64url");

  return [
    encode(JSON.stringify({ alg: "none" })),
    encode(fixture(claimsFixture)),
    "unsigned",
  ].join(".");
}

/** Replies with an error status and an orchestrator-style message. */
export const fail =
  (status: number, message: string): Route =>
  () =>
    Response.json({ message }, { status });

/**
 * A fetch that answers from recorded fixtures, keyed by "METHOD origin+path",
 * and records every request so tests can assert what was sent.
 */
export function fakeFetch(routes: Record<string, Route>) {
  const requests: RecordedRequest[] = [];

  const impl = async (input: string, init: RequestInit = {}) => {
    const request: RecordedRequest = {
      url: new URL(input),
      method: init.method ?? "GET",
      headers: new Headers(init.headers),
    };

    requests.push(request);

    const route =
      routes[`${request.method} ${request.url.origin}${request.url.pathname}`];

    return route
      ? route(request)
      : fail(404, `no fixture for ${request.url.pathname}`)(request);
  };

  return { fetch: impl, requests };
}

export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
