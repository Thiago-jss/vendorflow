const CALENDAR_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A needed-by date is a day, not an instant: it must mean the same thing to a requester in
 * Manaus and to a buyer in São Paulo. Parsing to UTC midnight and storing it in a DATE
 * column keeps that true without introducing a timezone the product does not have.
 *
 * Returns `null` for anything that is not a real calendar day, including values a regular
 * expression alone accepts — `Date` happily rolls 2026-02-30 forward, so the round trip is
 * what actually rejects it.
 */
export function parseCalendarDate(value: string): Date | null {
  const match = CALENDAR_DATE_PATTERN.exec(value);

  if (match === null) {
    return null;
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return formatCalendarDate(parsed) === value ? parsed : null;
}

export function formatCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}
