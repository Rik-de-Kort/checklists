// Fractional indexing: string keys that order a checklist's items by plain string comparison.
// A key can always be made between any two others, so moving an item only rewrites that item.
// After David Greenspan, https://observablehq.com/@dgreensp/implementing-fractional-indexing
//
// A key is an integer part followed by a fraction, both in base 62. The integer part's first
// character gives its length: "a" means 2 ("a0"…"az"), up to "z" (27); "Z" down to "A" are the
// negative integers, getting longer as they get smaller. Appending increments the integer, so
// keys stay short; inserting between two keys with the same integer extends the fraction.
import type { EpochMs } from "./types.ts";

// In ASCII order, so string comparison is numeric comparison.
const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ZERO = "0";
const LAST = "z";
/** The smallest integer: no key sorts before it, so it can't be a key itself. */
const SMALLEST = "A" + ZERO.repeat(26);
/** keyFromTime's integer part: 7 digits hold times until 62⁷ ms after 1970, in the year 2081. */
const TIME_DIGITS = 7;
const TIME_HEAD = "g"; // the head of integers with 7 digits

function digit(c: string | undefined): number {
  const d = c === undefined ? -1 : DIGITS.indexOf(c);
  if (d < 0) throw new Error(`Not a base-62 digit: ${JSON.stringify(c)}`);
  return d;
}

function integerLength(head: string): number {
  if (head >= "a" && head <= "z") return head.charCodeAt(0) - 97 + 2;
  if (head >= "A" && head <= "Z") return 90 - head.charCodeAt(0) + 2;
  return 0;
}

/** Fractions never end in zero: "V" and "V0" would be equal, with no key between them. */
export function isKey(key: string): boolean {
  const n = integerLength(key.charAt(0));
  const integer = key.slice(0, n);
  return n > 0 && integer.length === n && integer !== SMALLEST &&
    !key.slice(n).endsWith(ZERO) &&
    [...key.slice(1)].every((c) => DIGITS.includes(c));
}

function split(key: string): [integer: string, fraction: string] {
  if (!isKey(key)) throw new Error(`Invalid order key: ${JSON.stringify(key)}`);
  const n = integerLength(key.charAt(0));
  return [key.slice(0, n), key.slice(n)];
}

/** Digits strictly between the fractions 0.a and 0.b; b = null means 1. */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`midpoint: ${a} >= ${b}`);
  if (b) {
    // Skip the shared prefix. a is padded with zeros: "V" and "V1" share the "V".
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? digit(a[0]) : 0;
  const db = b !== null ? digit(b[0]) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round((da + db) / 2)]!;
  // Adjacent first digits need another digit: b's first digit alone, if that's still below b…
  if (b && b.length > 1) return b.slice(0, 1);
  // …or else a's first digit followed by something above the rest of a.
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

function increment(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = [...integer.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digit(digits[i]) + 1;
    if (d < DIGITS.length) {
      digits[i] = DIGITS[d]!;
      return head + digits.join("");
    }
    digits[i] = ZERO;
  }
  // Every digit carried: move to the next length ("az" -> "b00").
  if (head === "Z") return "a" + ZERO;
  if (head === "z") return null;
  const next = String.fromCharCode(head.charCodeAt(0) + 1);
  if (next > "a") digits.push(ZERO);
  else digits.pop();
  return next + digits.join("");
}

function decrement(integer: string): string | null {
  const head = integer.charAt(0);
  const digits = [...integer.slice(1)];
  for (let i = digits.length - 1; i >= 0; i--) {
    const d = digit(digits[i]) - 1;
    if (d >= 0) {
      digits[i] = DIGITS[d]!;
      return head + digits.join("");
    }
    digits[i] = LAST;
  }
  // Every digit borrowed: move to the previous length ("b00" -> "az", "a0" -> "Zz").
  if (head === "a") return "Z" + LAST;
  if (head === "A") return null;
  const prev = String.fromCharCode(head.charCodeAt(0) - 1);
  if (prev < "Z") digits.push(LAST);
  else digits.pop();
  return prev + digits.join("");
}

/** A key sorting strictly between a and b. null means the start (a) or end (b) of the list. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: ${a} is not before ${b}`);
  }
  if (a === null) {
    if (b === null) return "a" + ZERO;
    const [ib, fb] = split(b);
    if (ib === SMALLEST) return ib + midpoint("", fb);
    if (fb) return ib;
    const prev = decrement(ib);
    if (prev === null) throw new Error(`No key before ${b}`);
    return prev;
  }
  const [ia, fa] = split(a);
  if (b === null) return increment(ia) ?? ia + midpoint(fa, null);
  const [ib, fb] = split(b);
  if (ia === ib) return ia + midpoint(fa, fb);
  const next = increment(ia);
  if (next === null) throw new Error(`No integer after ${a}`);
  return next < b ? next : ia + midpoint(fa, null);
}

/**
 * The key of an item that was never placed by hand: ordered by creation time, as items were before
 * they could be moved. It depends on nothing but the time, so every device derives the same key.
 */
export function keyFromTime(ms: EpochMs): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new Error(`keyFromTime: invalid time ${ms}`);
  }
  let n: number = ms;
  let digits = "";
  for (let i = 0; i < TIME_DIGITS; i++) {
    digits = DIGITS[n % DIGITS.length]! + digits;
    n = Math.floor(n / DIGITS.length);
  }
  if (n > 0) throw new Error(`keyFromTime: ${ms} is too far in the future`);
  return TIME_HEAD + digits;
}
