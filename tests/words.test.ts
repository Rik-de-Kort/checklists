import assert from "node:assert/strict";
import { wordId, WORDS } from "../src/words.ts";

Deno.test("the wordlist is 1295 distinct lowercase words", () => {
  assert.equal(WORDS.length, 1295);
  assert.equal(new Set(WORDS).size, WORDS.length);
  assert.ok(WORDS.every((w) => /^[a-z]+$/.test(w)));
});

Deno.test("wordId is five words from the list, and doesn't repeat", () => {
  const ids = Array.from({ length: 1000 }, wordId);
  for (const id of ids) {
    const words = id.split("-");
    assert.equal(words.length, 5, id);
    assert.ok(words.every((w) => WORDS.includes(w)), id);
  }
  assert.equal(new Set(ids).size, ids.length);
});
