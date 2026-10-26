import assert from "node:assert/strict";
import { localDate, relTime } from "../src/time.ts";
import type { EpochMs } from "../src/types.ts";

Deno.test("the export date is the local date, not the UTC date", () => {
  // 22:30 UTC on the 24th is 00:30 on the 25th in Amsterdam (CEST, UTC+2).
  const lateEvening = Temporal.Instant.from("2026-10-24T22:30:00Z");
  assert.equal(localDate(lateEvening, "Europe/Amsterdam"), "2026-10-25");
  assert.equal(localDate(lateEvening, "UTC"), "2026-10-24");
});

Deno.test("relTime shows a time today, a weekday this week, and a date before that", () => {
  const zone = "Europe/Amsterdam";
  const nowLocal = Temporal.Now.zonedDateTimeISO(zone);
  const at = (z: Temporal.ZonedDateTime) => z.epochMilliseconds as EpochMs;
  const todayAtNoon = nowLocal.with({ hour: 12, minute: 5 });
  assert.match(relTime(at(todayAtNoon), zone, "en-GB"), /^12:05$/);
  const threeDaysAgo = nowLocal.subtract({ days: 3 });
  assert.equal(
    relTime(at(threeDaysAgo), zone, "en-GB"),
    threeDaysAgo.toLocaleString("en-GB", { weekday: "short" }),
  );
  const lastMonth = nowLocal.subtract({ days: 30 });
  assert.equal(
    relTime(at(lastMonth), zone, "en-GB"),
    lastMonth.toPlainDate().toLocaleString("en-GB"),
  );
});
