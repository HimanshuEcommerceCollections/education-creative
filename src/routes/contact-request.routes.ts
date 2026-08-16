import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  contactRequestQuerySchema,
  submitContactRequestSchema,
  updateContactRequestSchema,
} from "../contracts/contact-requests.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  getContactRequest,
  listContactRequests,
  submitContactRequest,
  updateContactRequest,
} from "../services/contact-request.service.ts";
import { resolveSession } from "../services/session.service.ts";

const idParamsSchema = z.object({ id: z.uuid() });

/** What every submission is answered with, real or discarded. */
const SUBMITTED_MESSAGE = "Thanks — your message is with us and we'll be in touch by email.";

/**
 * The signed-in user behind a public request, if there happens to be one.
 *
 * Not `app.authenticate`: this is a form anyone may use, so an absent, expired or
 * simply wrong token has to be worth exactly nothing rather than a 401. What a
 * valid one buys is the link from an enquiry to the sender's bookings.
 *
 * `resolveSession` is the authoritative verifier (`plugins/authenticate.ts` uses
 * the same one). The idle window is deliberately **not** touched here — filling
 * in a contact form is not evidence of an active session, and extending one from
 * an unauthenticated route would let a stolen token be kept alive without ever
 * being used for anything.
 */
async function optionalSenderId(request: FastifyRequest): Promise<string | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;

  const token = header.slice("Bearer ".length).trim();
  if (!token) return null;

  const principal = await resolveSession(token);
  return principal?.userId ?? null;
}

export async function contactRequestRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The public form at `/contact`. No account needed, and none created.
   */
  app.post(
    "/",
    // Its own scope at the same magnitude as `/educator-applications`: a person
    // with a real problem writes twice, not five times an hour, and this endpoint
    // sends mail to an address the caller chooses.
    { preHandler: [rateLimit({ max: 5, windowSeconds: 60 * 60, scope: "contact" })] },
    async (request, reply) => {
      /*
       * Honeypot, checked before the schema rather than after it. Answered exactly
       * as a real submission is and stored nowhere: a bot told it was caught comes
       * back having learned which field to leave alone, and a validation error
       * naming `website` tells it precisely that. Reading the raw field is what
       * keeps that true whatever else in the body is malformed.
       *
       * Logged with the IP so the volume is visible — that number is the only
       * evidence of whether this form needs a real challenge.
       */
      const submitted = request.body as { website?: unknown } | null;
      if (typeof submitted?.website === "string" && submitted.website.length > 0) {
        request.log.info(
          { ip: requestContext(request).ip },
          "contact form honeypot filled — submission discarded",
        );
        return reply.status(201).send({ message: SUBMITTED_MESSAGE });
      }

      const input = submitContactRequestSchema.parse(request.body);
      const senderUserId = await optionalSenderId(request);
      await submitContactRequest(input, requestContext(request), senderUserId);

      return reply.status(201).send({ message: SUBMITTED_MESSAGE });
    },
  );

  // -------------------------------------------------------------------------
  // The staff queue. Admin and coordinator both work it (§5 permission matrix);
  // nothing below is ever readable by the person who wrote in.
  // -------------------------------------------------------------------------

  app.get("/", { preHandler: [app.requireStaff] }, async (request) => {
    const query = contactRequestQuerySchema.parse(request.query);
    return listContactRequests(query, request.principal!);
  });

  app.get("/:id", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    return getContactRequest(id);
  });

  /**
   * Claim, progress, resolve. One endpoint because they are one gesture on a
   * queue screen, and because the timestamps that make the queue measurable have
   * to be derived from the transition rather than sent by the caller.
   */
  app.patch("/:id", { preHandler: [app.requireStaff] }, async (request) => {
    const { id } = idParamsSchema.parse(request.params);
    const input = updateContactRequestSchema.parse(request.body);
    return updateContactRequest(id, input, request.principal!, requestContext(request));
  });
}
