import assert from "node:assert/strict";
import { isKey, keyBetween, keyFromTime } from "../src/order.ts";
import type { EpochMs } from "../src/types.ts";

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32), so failures can be replayed. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

function assertSorted(keys: string[]): void {
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1]! < keys[i]!, `${keys[i - 1]} < ${keys[i]}`);
  }
}

Deno.test("keys between neighbours", () => {
  assert.equal(keyBetween(null, null), "a0");
  assert.equal(keyBetween("a0", null), "a1");
  assert.equal(keyBetween(null, "a0"), "Zz");
  assert.equal(keyBetween("a0", "a1"), "a0V");
  assert.equal(keyBetween("a0V", "a0W"), "a0VV");
  assert.equal(keyBetween("a0V", "a0V1"), "a0V0V");
  assert.equal(keyBetween("a0", "a5"), "a1", "a whole integer fits");
  assert.equal(keyBetween(null, "a0V"), "a0");
});

Deno.test("appending keeps keys short", () => {
  const keys: string[] = [];
  let last: string | null = null;
  for (let i = 0; i < 4000; i++) keys.push(last = keyBetween(last, null));
  assertSorted(keys);
  assert.deepEqual(keys.slice(61, 63), ["az", "b00"]);
  assert.equal(keys.at(-1)!.length, 4);
  // And the same going the other way.
  const before: string[] = [];
  let first: string | null = null;
  for (let i = 0; i < 4000; i++) {
    before.unshift(first = keyBetween(null, first));
  }
  assertSorted(before);
  assert.equal(before[0]!.length, 4);
});

Deno.test("inserting into the same gap again and again", () => {
  let b = "a1";
  for (let i = 0; i < 100; i++) {
    const k = keyBetween("a0", b);
    assert.ok("a0" < k && k < b, k);
    b = k;
  }
  assert.ok(b.length < 25, b);
});

Deno.test("random inserts stay sorted and distinct", () => {
  const rand = random(1);
  const keys: string[] = [];
  for (let i = 0; i < 5000; i++) {
    const at = Math.floor(rand() * (keys.length + 1));
    keys.splice(at, 0, keyBetween(keys[at - 1] ?? null, keys[at] ?? null));
  }
  assertSorted(keys);
  assert.ok(keys.every(isKey));
  assert.ok(Math.max(...keys.map((k) => k.length)) < 12);
});

Deno.test("keys from creation times sort by time and mix with other keys", () => {
  const times = [0, 1, 61, 62, 1_700_000_000_000, 62 ** 7 - 1] as EpochMs[];
  const keys = times.map(keyFromTime);
  assertSorted(keys);
  assert.ok(keys.every(isKey));
  assert.equal(keys[0], "g0000000");
  assert.throws(() => keyFromTime(62 ** 7 as EpochMs), /future/);
  assert.throws(() => keyFromTime(-1 as EpochMs), /invalid/);
  // A list of items from before positions, with one moved between two others and one added.
  const [a, b] = keys.slice(3, 5) as [string, string];
  assert.ok(a < keyBetween(a, b) && keyBetween(a, b) < b);
  assert.ok(keyBetween(b, null) > b);
  assert.ok(keyBetween(null, a) < a);
});

Deno.test("invalid keys and arguments are rejected", () => {
  for (const key of ["", "a", "a0V0", "a0!", "!0", "A" + "0".repeat(26)]) {
    assert.ok(!isKey(key), key);
    assert.throws(() => keyBetween(key, null), /Invalid order key/, key);
  }
  assert.throws(() => keyBetween("a1", "a0"), /not before/);
  assert.throws(() => keyBetween("a1", "a1"), /not before/);
});
