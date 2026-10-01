/** Which field a linking failure is about, so the page can point at it. */
export type LinkField = "api_key" | "endpoint";

/** A linking failure explained in words the person pasting the key can act on. */
export class LinkError extends Error {
  constructor(
    message: string,
    readonly field: LinkField,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

const ENDPOINT_EXAMPLE = "abc123.us1.cloud.expanso.io:9010";

export function notAnApiKey(): LinkError {
  return new LinkError(
    "That is not an Expanso API key. Keys start with exp_ak_; copy the whole key from Expanso Cloud.",
    "api_key",
  );
}

/** Explains why Expanso Cloud would not exchange the key; no status means unreachable. */
export function keyRejected(status: number | undefined): LinkError {
  if (status === undefined) {
    return new LinkError(
      "Expanso Cloud could not be reached to check the key. Try again in a minute.",
      "api_key",
    );
  }

  if (status === 401) {
    return new LinkError(
      "Expanso Cloud does not recognize this API key. It may be mistyped, revoked, or expired. Create a new key and paste it again.",
      "api_key",
    );
  }

  if (status === 403) {
    return new LinkError(
      "Expanso Cloud refused this API key (HTTP 403). Create a key from a workspace's Keys page and paste it again.",
      "api_key",
    );
  }

  return new LinkError(
    `Expanso Cloud could not check the key (HTTP ${status}). Try again in a minute.`,
    "api_key",
  );
}

export function notAnEndpoint(raw: string): LinkError {
  return new LinkError(
    `"${raw}" is not an Expanso workspace endpoint. It looks like ${ENDPOINT_EXAMPLE}; copy it from your workspace in Expanso Cloud.`,
    "endpoint",
  );
}

export function keyForOtherWorkspace(
  keyWorkspace: string,
  requested: string,
): LinkError {
  return new LinkError(
    `This API key was created for workspace ${keyWorkspace}, so it cannot open workspace ${requested}. Use a key created in workspace ${requested}.`,
    "endpoint",
  );
}

/** The key works, but it belongs to someone other than the connected account. */
export function keyForOtherAccount(): LinkError {
  return new LinkError(
    "This API key belongs to a different Expanso user or organization than the account connected to ChatGPT. Use a key you created yourself in the same organization.",
    "api_key",
  );
}

/** How a workspace read failed, without any request or credential detail. */
export type WorkspaceFailure =
  | { kind: "http"; status: number }
  | { kind: "unexpected" }
  | { kind: "unreachable" };

/** Explains why a workspace would not answer a read with the exchanged key. */
export function workspaceRejected(
  workspaceId: string,
  failure: WorkspaceFailure,
): LinkError {
  if (
    failure.kind === "http" &&
    (failure.status === 401 || failure.status === 403)
  ) {
    return new LinkError(
      `Workspace ${workspaceId} rejected this API key. The key belongs to a different organization or workspace; create one on workspace ${workspaceId}'s Keys page.`,
      "endpoint",
    );
  }

  if (failure.kind === "unexpected") {
    return new LinkError(
      `Workspace ${workspaceId} answered, but not in a form Expanso Fleet can read yet. Nothing is wrong with the key or endpoint; please report this.`,
      "endpoint",
    );
  }

  const reason =
    failure.kind === "http"
      ? `it answered HTTP ${failure.status}`
      : "there was no answer";

  return new LinkError(
    `Workspace ${workspaceId} could not be read at that endpoint (${reason}). Check that the endpoint is copied exactly, including the port.`,
    "endpoint",
  );
}
