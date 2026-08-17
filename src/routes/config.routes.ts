import type { FastifyInstance } from "fastify";

import { updateConfigSchema } from "../contracts/config.ts";
import { rateLimit } from "../plugins/rate-limit.ts";
import { requestContext } from "../plugins/request-context.ts";
import {
  getConfigAdminView,
  getConfigSnapshot,
  updateConfigSettings,
} from "../services/config.service.ts";

/**
 * Site configuration (§7). One public read — the allowlisted snapshot the site
 * renders its booking rules and feature switches from — and staff writes.
 *
 * `requireStaff` rather than `requireRole("admin")` on the writes, because a
 * coordinator owns the operational subset (§5). Which *settings* a role may move
 * is decided per-key in the service against the registry, so the route's job is
 * only to establish that a staff member is asking: a coordinator who posts
 * `platform.take_rate_bps` is refused by name there, not waved through here.
 */
export async function configRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Public. Read through Next's `config` cache tag, which the dashboard's own
   * actions bust on every write — so the rate limit is a backstop against
   * someone hammering the origin directly, not the normal path.
   */
  app.get(
    "/snapshot",
    { preHandler: [rateLimit({ max: 120, windowSeconds: 60, scope: "config" })] },
    async () => getConfigSnapshot(),
  );

  app.get("/admin", { preHandler: [app.requireStaff] }, async (request) =>
    getConfigAdminView(request.principal!.activeRole),
  );

  app.post("/settings", { preHandler: [app.requireStaff] }, async (request) => {
    const input = updateConfigSchema.parse(request.body);
    const { updated } = await updateConfigSettings(
      input,
      request.principal!,
      requestContext(request),
    );

    return {
      updated,
      message:
        updated === 0
          ? "No changes to save."
          : `Saved — ${updated} setting${updated === 1 ? "" : "s"} updated.`,
    };
  });
}
