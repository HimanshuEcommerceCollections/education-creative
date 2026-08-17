import { env } from "../env.ts";

/**
 * Refuses to run a fake-data seed unless the operator names the database.
 *
 * The failure this exists for has already happened: a development `.env` held the
 * production `DATABASE_URL`, so every `npm run seed:*` wrote invented parents,
 * bookings and reviews straight into production — and nothing in the run said
 * which database it was talking to.
 *
 * `NODE_ENV` cannot catch that, because the mistake is a production database
 * reached from a development machine, where every environment signal says
 * "development". The only fact that distinguishes them is the host, so the
 * operator has to name it: `SEED_TARGET` must match the host actually configured,
 * which turns seeding into something you state rather than something you repeat
 * out of habit.
 *
 * It stops an accident, not a determined mistake. Someone who reads the refusal
 * and pastes the production host back in will seed production, and that is the
 * intended limit — the durable fix is a separate database for development.
 *
 * Bootstrap seeds (`seed:admin`, `seed:pricing`) deliberately do **not** call
 * this: they exist to be run against production once.
 */
export function assertSeedTarget(scriptName: string): void {
  const host = safeHost(env.DATABASE_URL);
  const declared = process.env.SEED_TARGET?.trim();

  if (!declared) {
    fail(
      `${scriptName} writes invented data and will not guess which database to write it to.`,
      host,
    );
  }

  if (!host.includes(declared)) {
    fail(
      `SEED_TARGET is "${declared}", which is not part of the configured database host.`,
      host,
    );
  }
}

function safeHost(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    // A URL this malformed would not have connected, but a guard that throws its
    // own error instead of the refusal below would hide why the run stopped.
    return "(unparseable DATABASE_URL)";
  }
}

function fail(reason: string, host: string): never {
  console.error(
    [
      "",
      `Refusing to seed: ${reason}`,
      "",
      `  Configured database host:  ${host}`,
      "",
      "  If that is a development database, name it and run again:",
      `    SEED_TARGET=${host.split(".")[0]} npm run <the seed script>`,
      "",
      "  If it is production, stop. Point DATABASE_URL at a development database",
      "  first — a Neon branch is the intended way — because these scripts create",
      "  fake parents, bookings and reviews that a real deployment then serves.",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
