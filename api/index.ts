import type { IncomingMessage, ServerResponse } from "node:http";

import { buildApp } from "../src/app.ts";

/**
 * Vercel serverless entry point.
 *
 * `src/server.ts` remains the entry for a long-lived process (`npm run dev`, or a
 * container on Render/Fly). This file exists only because Vercel invokes a
 * function per request rather than running a listening server, so `app.listen()`
 * is never called here.
 *
 * The built app is cached across invocations that reuse a warm instance — Fastify
 * plugin registration and route compilation are not cheap, and repeating them per
 * request would add tens of milliseconds to every call. A cold start still pays it
 * once.
 *
 * The promise itself is cached rather than the instance, so concurrent cold
 * invocations share one build instead of racing to construct several.
 */
let appPromise: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;

async function getApp() {
  appPromise ??= (async () => {
    const app = await buildApp();
    // Required before handing raw requests to the server: it finishes plugin
    // loading and builds the router.
    await app.ready();
    return app;
  })();

  return appPromise;
}

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const app = await getApp();

  // Hand the raw Node request to Fastify's underlying server. `app.inject()` would
  // copy the whole request and response through a fake socket; emitting the event
  // lets Fastify stream as normal.
  app.server.emit("request", request, response);
}
