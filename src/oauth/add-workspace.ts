import { apiKeysPageUrl } from "../config.js";
import { ConnectionStore } from "../connections.js";
import { consumeAddLink, readAddLink, type AddLink } from "../links.js";
import { linkAccount, type LinkDeps } from "./authorize.js";
import { keyForOtherAccount, LinkError } from "./link-errors.js";
import {
  addWorkspacePage,
  connectedPage,
  errorPage,
  PAGE_CSP,
  type LinkFormState,
} from "./page.js";

export interface AddWorkspaceDeps extends LinkDeps {
  kv: KVNamespace;
  now?: () => number;
}

const EXPIRED =
  "This link has expired or was already used. Ask Expanso Fleet in ChatGPT to connect a workspace again for a new link.";

/**
 * The interim paste flow for an account already signed in: GET shows the
 * form, POST checks the key and endpoint, caches the key, and makes the
 * workspace active. Each one-time link connects one workspace for the
 * account that asked for it, and expires after ten minutes.
 */
export async function handleAddWorkspace(
  request: Request,
  deps: AddWorkspaceDeps,
): Promise<Response> {
  if (request.method === "GET") {
    const token = new URL(request.url).searchParams.get("token") ?? "";
    const link = await readAddLink(deps, token);

    if (!link) return errorPage(EXPIRED, 410);

    return page(token, { endpoint: link.endpoint }, deps);
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const form = await request.formData();
  const token = String(form.get("token") ?? "");
  const link = await readAddLink(deps, token);

  if (!link) return errorPage(EXPIRED, 410);

  const endpointText = String(form.get("endpoint") ?? "");

  try {
    const workspaceId = await connect(
      link,
      String(form.get("api_key") ?? ""),
      endpointText,
      deps,
    );

    await consumeAddLink(deps, token);

    return html(connectedPage(workspaceId), 200);
  } catch (error) {
    if (error instanceof LinkError) {
      // The link stays valid so the person can correct and resubmit.
      return page(
        token,
        {
          endpoint: endpointText,
          error: error.message,
          errorField: error.field,
        },
        deps,
      );
    }

    throw error;
  }
}

async function connect(
  link: AddLink,
  apiKey: string,
  endpointText: string,
  deps: AddWorkspaceDeps,
): Promise<string> {
  const { identity, connection } = await linkAccount(
    apiKey,
    endpointText,
    deps,
  );

  if (identity.accountId !== link.accountId) throw keyForOtherAccount();

  await new ConnectionStore(link.accountId, {
    kv: deps.kv,
    encryptionKey: deps.encryptionKey,
  }).add(connection);

  return connection.workspaceId;
}

function page(
  token: string,
  state: LinkFormState,
  deps: AddWorkspaceDeps,
): Response {
  return html(
    addWorkspacePage({
      ...state,
      token,
      apiKeysUrl: apiKeysPageUrl(deps.config.consoleUrl),
    }),
    state.error ? 400 : 200,
  );
}

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": PAGE_CSP,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
    },
  });
}
