import type { Request } from "express";

/**
 * The Microsoft OAuth callback URL, derived from the incoming request so it
 * works across localhost/dev and proxied HTTPS (Railway). The start/callback
 * routes and the Settings › Setup display must agree on this exact value — it's
 * the Redirect URI the admin registers on the Entra ID app registration.
 */
export function microsoftRedirectUri(req: Request): string {
  const proto =
    (req.headers["x-forwarded-proto"] as string | undefined) || (req.secure ? "https" : "http");
  return `${proto}://${req.get("host")}/api/channels/microsoft/oauth/callback`;
}
