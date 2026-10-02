import type {
  AuthRequest,
  OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

/**
 * Parse an /authorize request, answering a bad one with a 400 rather than
 * letting the provider's throw surface as a 500.
 *
 * An unknown client_id or a redirect_uri that does not match a registered one
 * must not be redirected (RFC 6749 §4.1.2.1): the error goes straight back to
 * the user agent. An unknown client gets `invalid_client`; anything else the
 * provider rejects gets `invalid_request` with its description.
 */
export async function parseAuthRequestOrReject(
  request: Request,
  provider: Pick<OAuthHelpers, "parseAuthRequest" | "lookupClient">,
): Promise<AuthRequest | Response> {
  const clientId = new URL(request.url).searchParams.get("client_id");
  if (!clientId) {
    return authorizeError("invalid_request", "client_id is required");
  }

  let client: Awaited<ReturnType<OAuthHelpers["lookupClient"]>> = null;
  try {
    client = await provider.lookupClient(clientId);
  } catch {
    client = null;
  }
  if (!client) {
    return authorizeError("invalid_client", "Unknown client_id");
  }

  try {
    return await provider.parseAuthRequest(request);
  } catch (error) {
    return authorizeError(
      "invalid_request",
      error instanceof Error && error.message
        ? error.message
        : "Invalid authorization request",
    );
  }
}

function authorizeError(error: string, description: string): Response {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store" } },
  );
}
