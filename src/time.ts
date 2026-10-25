// Time handling. Everything stored or synced is EpochMs (UTC); local time zones appear only in display helpers.
import type { EpochMs } from './types.ts';

if (typeof Temporal === 'undefined') {
  throw new Error('This browser lacks the Temporal API. Please update it.');
}

let last = 0;

// Strictly increasing, so records created in one burst (e.g. a clone) keep their order,
// and never behind a timestamp seen from another device (see observe()).
export function now(): EpochMs {
  last = Math.max(Temporal.Now.instant().epochMilliseconds, last + 1);
  return last as EpochMs;
}

// Keeps last-writer-wins sane when another device's clock runs ahead of ours.
export function observe(ts: EpochMs): void {
  last = Math.max(last, ts);
}

export function toInstant(ts: EpochMs): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(ts);
}

/** Chat-style timestamp: a time today, a weekday within the last week, otherwise a date. */
export function relTime(ts: EpochMs, timeZone: string = Temporal.Now.timeZoneId(), locale?: string): string {
  const local = toInstant(ts).toZonedDateTimeISO(timeZone);
  const today = Temporal.Now.plainDateISO(timeZone);
  const daysAgo = local.toPlainDate().until(today).days;
  if (daysAgo === 0) return local.toLocaleString(locale, { hour: '2-digit', minute: '2-digit' });
  if (daysAgo > 0 && daysAgo < 7) return local.toLocaleString(locale, { weekday: 'short' });
  return local.toPlainDate().toLocaleString(locale);
}

/** Today's date where the user is, e.g. for file names. */
export function localDate(at: Temporal.Instant = Temporal.Now.instant(), timeZone: string = Temporal.Now.timeZoneId()): string {
  return at.toZonedDateTimeISO(timeZone).toPlainDate().toString();
}
