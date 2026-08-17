import type { FastifyRequest } from "fastify";

import type { RequestContext } from "../services/auth.service.ts";

declare module "fastify" {
  interface FastifyRequest {
    /**
     * Set by the internal-hop hook in `app.ts`: true once the caller proved
     * `INTERNAL_API_SECRET`, or on every request when that secret is unset.
     */
    internalHopVerified?: boolean;
  }
}

/**
 * The real client address, as far as it can be established.
 *
 * `x-client-ip` is set deliberately by the Next BFF, which is the only thing that
 * knows the browser's address — but it is also just a request header, so it is
 * read only on a hop that authenticated itself. Honouring it unconditionally
 * hands any scripted caller a fresh rate-limit bucket per value, and writes an
 * attacker-chosen address into `consent_records.ip` and `audit_log.ip`, which are
 * the COPPA consent evidence.
 *
 * The fallback is `request.ip`, not a single shared bucket: under `trustProxy`
 * that resolves from `x-forwarded-for`, so for a caller reaching this service
 * directly it is that caller's own address.
 *
 * IP is recorded on consent records and audit rows, so getting it wrong makes
 * those records misleading rather than merely imprecise.
 */
export function clientIp(request: FastifyRequest): string | null {
  if (request.internalHopVerified) {
    const forwarded = request.headers["x-client-ip"];
    const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (forwardedIp?.trim()) return forwardedIp.trim();
  }

  return request.ip || null;
}

export function requestContext(request: FastifyRequest): RequestContext {
  return {
    ip: clientIp(request),
    userAgent: request.headers["x-client-user-agent"]?.toString() ?? null,
    requestId: request.id,
  };
}
