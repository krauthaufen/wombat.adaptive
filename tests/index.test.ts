// Index order maintenance: compares use a cached numeric key and fall
// back to the exact BigInt key only on ties; relabels keep the cache right.

import { describe, expect, test, vi } from "vitest";
import { Index, indexZero } from "../src/datastructures/index.js";

const exact = (i: Index): bigint => (i._real as unknown as { key: bigint }).key;
const keyProto = (i: Index): object => Object.getPrototypeOf(i._real) as object;

/** Builds a list of indices in order with many relabels: random
 *  insertions between neighbours plus long runs into one gap. */
function build(n: number, seed: number): Index[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const list: Index[] = [indexZero.after()];
  while (list.length < n) {
    const r = rnd();
    if (list.length < 2) list.push(list[0]!.after());
    else if (r < 0.3) {
      // a run into the same gap exhausts it: relabels
      const p = Math.floor(rnd() * (list.length - 1));
      for (let k = 0; k < 40 && list.length < n; k++) list.splice(p + 1, 0, list[p]!.between(list[p + 1]!));
    } else if (r < 0.5) list.push(list[list.length - 1]!.after());
    else if (r < 0.6) list.unshift(list[0]!.before());
    else {
      const p = Math.floor(rnd() * (list.length - 1));
      list.splice(p + 1, 0, list[p]!.between(list[p + 1]!));
    }
  }
  return list;
}

describe("Index", () => {
  test("compareTo agrees with the exact key after many relabels", () => {
    for (const seed of [1, 2, 3]) {
      const list = build(3000, seed);
      for (let i = 0; i + 1 < list.length; i++) {
        expect(list[i]!.compareTo(list[i + 1]!)).toBe(-1);
        expect(list[i + 1]!.compareTo(list[i]!)).toBe(1);
        expect(exact(list[i]!) < exact(list[i + 1]!)).toBe(true);
      }
      // random pairs
      for (let k = 0; k < 2000; k++) {
        const a = (k * 7919) % list.length, b = (k * 104729) % list.length;
        const want = a < b ? -1 : a > b ? 1 : 0;
        expect(list[a]!.compareTo(list[b]!)).toBe(want);
      }
    }
  });

  test("compareTo does not compute the BigInt key when the numeric keys differ", () => {
    const list = build(500, 7);
    const spy = vi.spyOn(keyProto(list[0]!), "key", "get");
    try {
      const t0 = performance.now();
      let reps = 0;
      for (; reps < 200; reps++) for (let i = 0; i + 1 < list.length; i++) list[i]!.compareTo(list[i + 1]!);
      const ms = performance.now() - t0;
      console.log(`[bench] ${reps * (list.length - 1)} compares in ${ms.toFixed(1)} ms, ${spy.mock.calls.length} exact keys`);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
