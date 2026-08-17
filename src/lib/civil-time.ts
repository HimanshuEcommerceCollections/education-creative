import { BOOKING_TIMEZONE } from "../contracts/bookings.ts";

/**
 * Civil date and time arithmetic in the platform's operating timezone.
 *
 * A booking's `preferredDate` / `preferredTime` are **civil** values — "Saturday
 * the 14th at 4:00 PM" as read on a wall clock in `BOOKING_TIMEZONE` — not
 * instants. Storing them that way is deliberate (a DST change must not move a
 * lesson), but every *rule* about them is about time passing: is this at least a
 * day away, is it inside the window the calendar opens, is a cancellation early
 * enough for a full refund. Answering those needs the real UTC instant the civil
 * pair denotes, and that is the one thing a string cannot tell you.
 *
 * Built on `Intl` rather than a timezone library: the zone database ships with
 * Node, and the offset lookup below is the only thing being asked of it. No
 * dependency, and the same answers the client's calendar computes from the same
 * `Intl` data.
 */

export interface CivilDate {
  year: number;
  /** 1–12, unlike `Date#getMonth()`. */
  month: number;
  day: number;
}

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const CIVIL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const ZONE_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: BOOKING_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Parses `YYYY-MM-DD`, returning null for anything that isn't a date on the
 * calendar.
 *
 * The round trip is the whole point: `Date.UTC(2026, 12, 45)` rolls over into
 * February 2027 rather than failing, so `2026-13-45` and `2026-02-30` both look
 * like numbers until you put them in and read them back.
 */
export function parseCivilDate(value: string): CivilDate | null {
  const match = CIVIL_DATE.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const roundTrip = new Date(Date.UTC(year, month - 1, day));
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseCivilTime(value: string): { hour: number; minute: number } | null {
  const match = CIVIL_TIME.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

/**
 * The zone's UTC offset, in milliseconds, at a given instant.
 *
 * Formatting the instant in the zone and reading the civil fields back as
 * though they were UTC gives a number that differs from the instant by exactly
 * the offset — which is how you get an offset out of `Intl` without a table.
 */
function zoneOffsetMs(instant: number): number {
  const parts = ZONE_PARTS.formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  const asIfUtc = Date.UTC(
    read("year"),
    read("month") - 1,
    read("day"),
    read("hour"),
    read("minute"),
    read("second"),
  );

  return asIfUtc - instant;
}

/**
 * The UTC instant a civil date and `HH:MM` denote in `BOOKING_TIMEZONE`, or null
 * when either half isn't a valid civil value.
 *
 * Two passes over the offset. The offset has to be sampled *at* an instant, and
 * the instant is what's being solved for — so the first pass samples at the
 * civil numbers read as UTC and the second re-samples at that answer. One pass
 * lands on the wrong side of a DST transition for the few hours around it.
 *
 * The hour that doesn't exist on the spring-forward day resolves forward into
 * the hour that replaced it. That is the useful answer for a booking rule and
 * not worth refusing over: no educator's availability offers 2:30 AM.
 */
export function civilInstant(date: string, time: string): Date | null {
  const civil = parseCivilDate(date);
  const clock = parseCivilTime(time);
  if (!civil || !clock) return null;

  const asIfUtc = Date.UTC(civil.year, civil.month - 1, civil.day, clock.hour, clock.minute);
  const firstPass = asIfUtc - zoneOffsetMs(asIfUtc);

  return new Date(asIfUtc - zoneOffsetMs(firstPass));
}

/** Today's civil date where the platform operates. */
export function civilToday(at: Date = new Date()): CivilDate {
  const parts = ZONE_PARTS.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");

  return { year: read("year"), month: read("month"), day: read("day") };
}

/**
 * The last instant inside a booking window `monthsAhead` civil months wide: the
 * final minute of that month, so the whole of the last month a calendar can page
 * to is bookable.
 *
 * Whole months rather than a day count because that is what the client's
 * calendar does — it opens months, not a rolling 60 days — and the server's
 * refusal has to agree with the dates the parent was offered.
 */
export function endOfCivilMonthsAhead(monthsAhead: number, from: Date = new Date()): Date {
  const today = civilToday(from);

  const zeroBased = today.month - 1 + monthsAhead;
  const year = today.year + Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  // Day 0 of the following month is the last day of this one.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();

  // Non-null: the date is constructed from the calendar, and 23:59 exists on
  // every day in every zone.
  return civilInstant(`${year}-${pad(month)}-${pad(lastDay)}`, "23:59")!;
}

/** Hours from `from` until `instant`. Negative once it's in the past. */
export function hoursUntil(instant: Date, from: Date = new Date()): number {
  return (instant.getTime() - from.getTime()) / 3_600_000;
}
