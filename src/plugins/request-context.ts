import type { FastifyRequest } from "fastify";

import type { RequestContext } from "../services/auth.service.ts";

/**
 * Under the BFF every request arrives from Vercel's servers, so `request.ip` is
 * the proxy. The real client address comes from the forwarding header the Next
 * layer sets deliberately — trusted only because the API is not publicly
 * reachable by browsers.
 *
 * IP is recorded on consent records and audit rows, so getting it wrong makes
 * those records misleading rather than merely imprecise.
 */
export function requestContext(request: FastifyRequest): RequestContext {
  const forwarded = request.headers["x-client-ip"];
  const clientIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  return {
    ip: clientIp?.trim() || request.ip || null,
    userAgent: request.headers["x-client-user-agent"]?.toString() ?? null,
    requestId: request.id,
  };
}
