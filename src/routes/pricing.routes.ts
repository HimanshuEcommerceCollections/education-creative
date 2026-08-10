import type { FastifyInstance } from "fastify";

import {
  setEducatorRateSchema,
  updateFormatPolicySchema,
  upsertRateBandSchema,
} from "../contracts/pricing.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  getPricingAdminView,
  getPricingSnapshot,
  setEducatorRate,
  updateFormatPolicy,
  upsertRateBand,
} from "../services/pricing.service.ts";

/**
 * Pricing. One public read — the allowlisted snapshot every price on the site
 * renders from — and admin-only writes. Bands, rates and the format policy are
 * admin territory (§5/§7: coordinators run operations but cannot move money
 * rules), so every write is gated `requireRole("admin")`, not `requireStaff`.
 */
export async function pricingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public. The Next app fetches this with cache tags and revalidates on admin
   * writes, so the per-request cost lands on Vercel's cache, not here — the
   * rate limit is a backstop against someone hammering the origin directly.
   */
  app.get(
    "/snapshot",
    { preHandler: [rateLimit({ max: 120, windowSeconds: 60, scope: "pricing" })] },
    async () => getPricingSnapshot(),
  );

  app.get("/admin", { preHandler: [app.requireRole("admin")] }, async () =>
    getPricingAdminView(),
  );

  app.post("/bands", { preHandler: [app.requireRole("admin")] }, async (request) => {
    const input = upsertRateBandSchema.parse(request.body);
    await upsertRateBand(input, request.principal!, requestContext(request));
    return { message: `Band updated for ${input.subjectSlug}.` };
  });

  app.post(
    "/educator-rates",
    { preHandler: [app.requireRole("admin")] },
    async (request) => {
      const input = setEducatorRateSchema.parse(request.body);
      await setEducatorRate(input, request.principal!, requestContext(request));
      return { message: `Rate updated for ${input.educatorSlug}.` };
    },
  );

  app.post(
    "/format-policy",
    { preHandler: [app.requireRole("admin")] },
    async (request) => {
      const input = updateFormatPolicySchema.parse(request.body);
      await updateFormatPolicy(input, request.principal!, requestContext(request));
      return { message: "Format differential updated." };
    },
  );
}
