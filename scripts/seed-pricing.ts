import { and, eq, isNull } from "drizzle-orm";

import { closeDatabase, db } from "../src/db/client.ts";
import {
  educatorProfiles,
  educatorRates,
  formatPolicies,
  subjectRateBands,
  subjects,
} from "../src/db/schema/index.ts";
import { logger } from "../src/lib/logger.ts";

/**
 * Seeds the pricing tables from the numbers the client's `data/*.ts` files
 * hardcode today, so the cutover changes where prices live without changing a
 * single figure a parent sees. This is the §6 reconciliation point in miniature:
 * one profile row per marketing educator, their browse-grid rate as their
 * educator rate, and each service category's "from" price as its band minimum.
 *
 * **Idempotent and non-destructive**: a subject, band, rate, profile, or policy
 * that already exists is left exactly as it is — re-running after an admin has
 * edited pricing changes nothing.
 */

const SUBJECTS = [
  // slug matches the site's /subjects/* routes; band cents from services.ts
  // rateFrom (min) and the browse grid's going rates (suggested).
  { slug: "tutoring", title: "Academic Tutoring", sortOrder: 1, minCents: 5000, suggestedCents: 5500, maxCents: 9000 },
  { slug: "college-admissions", title: "College Admissions", sortOrder: 2, minCents: 6500, suggestedCents: 6500, maxCents: 12000 },
  { slug: "music", title: "Music", sortOrder: 3, minCents: 5400, suggestedCents: 6000, maxCents: 9000 },
  { slug: "languages", title: "Languages", sortOrder: 4, minCents: 4800, suggestedCents: 5200, maxCents: 8000 },
  { slug: "arts-crafts", title: "Arts & Crafts", sortOrder: 5, minCents: 4500, suggestedCents: 5000, maxCents: 7500 },
  { slug: "cooking", title: "Cooking", sortOrder: 6, minCents: 5400, suggestedCents: 5800, maxCents: 9000 },
] as const;

const EDUCATORS = [
  /*
   * `topics` are the fine-grained subjects the booking form offers and the API
   * validates a request against — the free-text list §7 keeps on the profile,
   * distinct from the priced `subjectSlug` category. They must stay in step with
   * the client's `data/booking.ts`, which renders the same list.
   *
   * Rates are the browse grid's dollar figures, in cents. Rosa is seeded under
   * cooking (her primary category) — her music listing is the known data drift
   * flagged for a founder decision in ARCHITECTURE.md §6. Her `topics` carry both,
   * so a music topic still books; it just prices against the cooking band until
   * that decision lands.
   */
  { slug: "elena", name: "Elena M.", headline: "Academic Tutoring", subjectSlug: "tutoring", rateCents: 5500, topics: ["Elementary math", "Algebra I & II", "Geometry", "Pre-Calculus", "Middle-school science", "Study skills"] },
  { slug: "daniel", name: "Daniel A.", headline: "Academic Tutoring", subjectSlug: "tutoring", rateCents: 5000, topics: ["Reading comprehension", "Writing & grammar", "Elementary math", "Study skills"] },
  { slug: "priya", name: "Priya S.", headline: "College Admissions", subjectSlug: "college-admissions", rateCents: 6500, topics: ["Application strategy", "Personal essay", "Interview practice", "Scholarship applications"] },
  { slug: "marcus", name: "Marcus T.", headline: "Music", subjectSlug: "music", rateCents: 6000, topics: ["Piano", "Guitar", "Music theory", "Beginner vocals"] },
  { slug: "rosa", name: "Rosa N.", headline: "Cooking & Music", subjectSlug: "cooking", rateCents: 5400, topics: ["Home cooking basics", "Baking", "Beginner vocals", "Music theory"] },
  { slug: "james", name: "James O.", headline: "Cooking", subjectSlug: "cooking", rateCents: 5800, topics: ["Knife skills", "Baking & pastry", "Family meal planning", "Food safety"] },
  { slug: "lena", name: "Lena K.", headline: "Languages (Spanish & French)", subjectSlug: "languages", rateCents: 5200, topics: ["Spanish conversation", "Spanish grammar", "French conversation", "French grammar"] },
  { slug: "sofia", name: "Sofia R.", headline: "Languages (Hindi & English)", subjectSlug: "languages", rateCents: 4800, topics: ["Hindi conversation", "Hindi reading & writing", "English conversation", "English pronunciation"] },
  { slug: "theo", name: "Theo W.", headline: "Arts & Crafts", subjectSlug: "arts-crafts", rateCents: 4500, topics: ["Drawing", "Painting", "Printmaking", "Craft projects"] },
] as const;

async function main(): Promise<void> {
  const subjectIds = new Map<string, string>();

  for (const subject of SUBJECTS) {
    await db
      .insert(subjects)
      .values({
        slug: subject.slug,
        title: subject.title,
        sortOrder: subject.sortOrder,
      })
      .onConflictDoNothing();

    const [row] = await db
      .select({ id: subjects.id })
      .from(subjects)
      .where(eq(subjects.slug, subject.slug))
      .limit(1);
    subjectIds.set(subject.slug, row!.id);

    const [band] = await db
      .select({ id: subjectRateBands.id })
      .from(subjectRateBands)
      .where(
        and(
          eq(subjectRateBands.subjectId, row!.id),
          isNull(subjectRateBands.effectiveTo),
        ),
      )
      .limit(1);

    if (!band) {
      await db.insert(subjectRateBands).values({
        subjectId: row!.id,
        minCents: subject.minCents,
        suggestedCents: subject.suggestedCents,
        maxCents: subject.maxCents,
      });
      logger.info({ subject: subject.slug }, "rate band seeded");
    }
  }

  for (const educator of EDUCATORS) {
    let [profile] = await db
      .select({ id: educatorProfiles.id })
      .from(educatorProfiles)
      .where(
        and(eq(educatorProfiles.slug, educator.slug), isNull(educatorProfiles.deletedAt)),
      )
      .limit(1);

    if (!profile) {
      /*
       * The marketing educators the site already displays as bookable. No user
       * account (userId null — nobody can log in as them) but verification
       * `approved`, because the site presents them as vetted today and the seed
       * must not silently unpublish the roster.
       */
      const [created] = await db
        .insert(educatorProfiles)
        .values({
          slug: educator.slug,
          name: educator.name,
          headline: educator.headline,
          verificationStatus: "approved",
          minRateCents: educator.rateCents,
          subjects: [...educator.topics],
        })
        .returning({ id: educatorProfiles.id });
      profile = created!;
      logger.info({ educator: educator.slug }, "educator profile seeded");
    } else {
      /*
       * Backfill. `subjects` arrived after the first seed ran, and an existing
       * profile with an empty list is bookable but unvalidated — so a re-run
       * refreshes the topics rather than skipping a profile it already found.
       */
      await db
        .update(educatorProfiles)
        .set({ subjects: [...educator.topics] })
        .where(eq(educatorProfiles.id, profile.id));
    }

    const [rate] = await db
      .select({ id: educatorRates.id })
      .from(educatorRates)
      .where(
        and(
          eq(educatorRates.educatorProfileId, profile.id),
          eq(educatorRates.subjectId, subjectIds.get(educator.subjectSlug)!),
          isNull(educatorRates.effectiveTo),
        ),
      )
      .limit(1);

    if (!rate) {
      await db.insert(educatorRates).values({
        educatorProfileId: profile.id,
        subjectId: subjectIds.get(educator.subjectSlug)!,
        rateCents: educator.rateCents,
      });
      logger.info(
        { educator: educator.slug, rateCents: educator.rateCents },
        "educator rate seeded",
      );
    }
  }

  const [policy] = await db
    .select({ id: formatPolicies.id })
    .from(formatPolicies)
    .where(isNull(formatPolicies.effectiveTo))
    .limit(1);

  if (!policy) {
    // ×1.0 and $0 travel — the differential the client ships with today. Turning
    // it on is an admin decision on /dashboard/pricing, not a seed default.
    await db.insert(formatPolicies).values({
      inHomeMultiplierBps: 10_000,
      travelFlatCents: 0,
    });
    logger.info("format policy seeded (in-home differential off)");
  }

  logger.info("pricing seed complete");
}

try {
  await main();
} catch (error) {
  logger.fatal({ err: error }, "pricing seed failed");
  await closeDatabase();
  process.exit(1);
}

await closeDatabase();
