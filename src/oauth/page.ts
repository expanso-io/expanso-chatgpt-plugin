import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export interface LinkFormState {
  endpoints?: string;
  error?: string;
  /** Which field the error is about, so it can be marked invalid. */
  errorField?: "api_key" | "endpoints";
  /** Expanso Cloud page for creating an API key. */
  apiKeysUrl?: string;
}

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const SCOPE_LABELS = new Map([
  [
    "fleet",
    "See and control your fleet: jobs, pipelines, nodes, and executions",
  ],
  ["logs", "Read bounded job log snapshots"],
]);

/**
 * The one-time linking page. Everything the client supplied (name, domain,
 * redirect host, scopes) is escaped: dynamic registration lets anyone choose it.
 */
export function linkPage(
  details: ConsentDescription,
  handle: string,
  state: LinkFormState = {},
): string {
  const client = escapeHtml(details.clientName);

  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";

  const scopes = details.scope
    .map(
      (scope) =>
        `<label class="scope"><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> <span>${escapeHtml(SCOPE_LABELS.get(scope) ?? scope)}</span> <code>${escapeHtml(scope)}</code></label>`,
    )
    .join("");

  const loopback = details.redirectIsLoopback
    ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>'
    : "";

  const error = state.error
    ? `<p class="error" role="alert" id="link-error">${escapeHtml(state.error)}</p>`
    : "";

  const invalid = (field: LinkFormState["errorField"]) =>
    state.errorField === field
      ? ' aria-invalid="true" aria-describedby="link-error"'
      : "";

  const getKey = state.apiKeysUrl
    ? `<section class="get-key" aria-labelledby="get-key-title">
    <h2 id="get-key-title">Get an API key</h2>
    <p><a class="button" href="${escapeHtml(state.apiKeysUrl)}" target="_blank" rel="noopener noreferrer">Get my key from Expanso Cloud</a></p>
    <ol>
      <li>In Expanso Cloud, open your workspace, then <strong>Keys</strong>.</li>
      <li>Create a key. Name it for this connection, for example <em>ChatGPT Expanso Fleet</em>, and choose <strong>No expiry</strong>.</li>
      <li>Copy the key (it starts with <code>exp_ak_</code>) and paste it below.</li>
      <li>In the same workspace, copy its <strong>Endpoint</strong> and paste it below.</li>
    </ol>
    <p class="note">The key has full access to its workspace. Expanso Fleet can deploy, stop, rerun, and delete jobs and change nodes with it, and ChatGPT asks you to confirm every change first.</p>
  </section>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Connect Expanso Fleet</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --ink: #1d1a24; --muted: #5d5868; --line: #ddd6e8; --paper: #f7f4fb;
    --card: #fffdfd; --brand: #6823cd; --brand-ink: #ffffff; --danger: #b3261e;
  }
  @media (prefers-color-scheme: dark) {
    :root { --ink: #eeeaf4; --muted: #aaa3b8; --line: #3a3446; --paper: #16131c;
      --card: #1f1b27; --brand: #a878ff; --brand-ink: #16131c; --danger: #ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; background:
    radial-gradient(120% 80% at 0% 0%, color-mix(in srgb, var(--brand) 10%, transparent), transparent 60%),
    var(--paper); color: var(--ink); font: 15px/1.55 "IBM Plex Sans", sans-serif; }
  main { max-width: 34rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
  h1 { font-size: 1.45rem; font-weight: 600; margin: 0 0 .5rem; letter-spacing: -.01em; }
  p { margin: 0 0 1rem; color: var(--muted); }
  form { background: var(--card); border: 1px solid var(--line); border-radius: 6px; padding: 1.5rem; }
  label.field { display: block; font-weight: 500; margin: 1.1rem 0 .35rem; }
  .hint { font-size: .85rem; color: var(--muted); margin: .3rem 0 0; }
  input[type=password], textarea { width: 100%; padding: .6rem .7rem; border: 1px solid var(--line);
    border-radius: 4px; background: var(--paper); color: var(--ink); font: 14px "IBM Plex Mono", monospace; }
  textarea { min-height: 4.5rem; resize: vertical; }
  input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .scope { display: flex; gap: .5rem; align-items: baseline; margin: .35rem 0; font-weight: 400; }
  .scope code { font: 12px "IBM Plex Mono", monospace; color: var(--muted); }
  .actions { display: flex; gap: .75rem; margin-top: 1.5rem; }
  button { font: 500 15px "IBM Plex Sans", sans-serif; padding: .6rem 1.1rem; border-radius: 4px; cursor: pointer; }
  .approve { background: var(--brand); color: var(--brand-ink); border: 1px solid var(--brand); }
  .deny { background: transparent; color: var(--ink); border: 1px solid var(--line); }
  .error { color: var(--danger); font-weight: 500; }
  [aria-invalid="true"] { border-color: var(--danger); }
  .get-key { border: 1px solid var(--line); border-radius: 6px; padding: 1rem 1.25rem; margin: 0 0 1.25rem; background: var(--card); }
  .get-key h2 { font-size: 1rem; margin: 0 0 .5rem; }
  .get-key ol { margin: .5rem 0; padding-left: 1.25rem; color: var(--muted); }
  .get-key li { margin: .25rem 0; }
  .get-key .note { font-size: .85rem; margin: .5rem 0 0; }
  a.button { display: inline-block; background: var(--brand); color: var(--brand-ink); text-decoration: none; font-weight: 500; padding: .5rem 1rem; border-radius: 4px; }
  a.button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .warn { color: var(--danger); }
  footer { margin-top: 1.5rem; font-size: .8rem; color: var(--muted); }
</style>
</head>
<body>
<main>
  <h1>Connect ${client} to Expanso Fleet</h1>
  <p>${origin} Access is sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
  ${loopback}
  ${getKey}
  <form method="post" autocomplete="off">
    <input type="hidden" name="handle" value="${escapeHtml(handle)}">
    ${error}
    <label class="field" for="api_key">Expanso API key</label>
    <input id="api_key" name="api_key" type="password" required spellcheck="false" placeholder="exp_ak_…"${invalid("api_key")}>
    <p class="hint">Create one in Expanso Cloud. It is checked with Expanso Cloud, then stored encrypted by this service. The plugin and ChatGPT never see it.</p>
    <label class="field" for="endpoints">Workspace endpoint</label>
    <textarea id="endpoints" name="endpoints" required spellcheck="false" placeholder="your-workspace.region.cloud.expanso.io:9010"${invalid("endpoints")}>${escapeHtml(state.endpoints ?? "")}</textarea>
    <p class="hint">Copy it from Expanso Cloud: your workspace, then Endpoint. One per line to link several workspaces in the same organization.</p>
    <label class="field">Access</label>
    ${scopes}
    <div class="actions">
      <button class="approve" name="decision" value="approve">Connect</button>
      <button class="deny" name="decision" value="deny" formnovalidate>Cancel</button>
    </div>
  </form>
  <footer>Expanso Fleet shows your fleet and changes it only when you confirm. Revoke the key in Expanso Cloud at any time to cut off access.</footer>
</main>
</body>
</html>`;
}

export function errorPage(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Expanso Fleet</title><p>${escapeHtml(message)}</p>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        "X-Frame-Options": "DENY",
      },
    },
  );
}

export const PAGE_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join("; ");
