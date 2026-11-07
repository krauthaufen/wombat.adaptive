// A chain of appends/concats reads through ONE flat reader: same content
// and deltas as nesting, without a reader (and remap) per level.

import { describe, expect, test } from "vitest";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { AList } from "../src/adaptiveIndexList/adaptiveIndexList.js";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import type { alist } from "../src/adaptiveIndexList/adaptiveIndexList.js";

const chain = (parts: alist<number>[]): alist<number> => parts.reduce((acc, p) => AList.append(acc, p));

describe("AList.append flattening", () => {
  test("reading an append chain does not evaluate the intermediate appends", () => {
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => clist<number>([i]));
    const ab = AList.append(a!, b!);
    const abc = AList.append(ab, c!);
    const all = AList.concat([abc, d!]);
    expect(all.content.force().toArray()).toEqual([0, 1, 2, 3]);
    const historyCount = (l: alist<number>) => (l as unknown as { history: { state: { count: number } } }).history.state.count;
    expect(historyCount(ab)).toBe(0);
    expect(historyCount(abc)).toBe(0);
  });

  test("content and incremental changes match the parts", () => {
    const parts = Array.from({ length: 30 }, (_, i) => clist<number>([i * 10, i * 10 + 1]));
    const all = chain(parts);
    const reader = all.getReader();
    const read = () => { reader.getChanges(AdaptiveToken.top); return reader.state.toArray(); };
    const want = () => parts.flatMap((p) => p.value.toArray());
    expect(read()).toEqual(want());
    transact(() => { parts[3]!.add(99); parts[0]!.prepend(-1); parts[29]!.removeAt(0); parts[15]!.clear(); });
    expect(read()).toEqual(want());
    expect(all.content.force().toArray()).toEqual(want());
  });

  test("a deep append chain builds in linear time and reads without recursion", () => {
    const n = 30000;
    const parts = Array.from({ length: n }, (_, i) => clist<number>([i]));
    const t0 = performance.now();
    const all = chain(parts);
    const buildMs = performance.now() - t0;
    expect(buildMs).toBeLessThan(2000);
    const reader = all.getReader();
    reader.getChanges(AdaptiveToken.top);
    expect(reader.state.count).toBe(n);
    expect(reader.state.toArray()[n - 1]).toBe(n - 1);
  });

  test("a shared sub-chain appearing twice is read twice", () => {
    const a = clist<number>([1]), b = clist<number>([2]);
    const ab = AList.append(a, b);
    const all = AList.concat([ab, AList.append(ab, a)]);
    const reader = all.getReader();
    reader.getChanges(AdaptiveToken.top);
    expect(reader.state.toArray()).toEqual([1, 2, 1, 2, 1]);
    transact(() => { a.add(3); });
    reader.getChanges(AdaptiveToken.top);
    expect(reader.state.toArray()).toEqual([1, 3, 2, 1, 3, 2, 1, 3]);
    expect(all.content.force().toArray()).toEqual([1, 3, 2, 1, 3, 2, 1, 3]);
  });

  test("bench: build + first read + 200 updates on a 300-part chain", () => {
    const parts = Array.from({ length: 300 }, (_, i) => clist<number>([i]));
    const t0 = performance.now();
    const reader = chain(parts).getReader();
    reader.getChanges(AdaptiveToken.top);
    for (let k = 0; k < 200; k++) {
      transact(() => { parts[(k * 37) % 300]!.add(k); });
      reader.getChanges(AdaptiveToken.top);
    }
    const ms = performance.now() - t0;
    console.log(`[bench] 300-part append chain: ${ms.toFixed(1)} ms`);
    expect(reader.state.count).toBe(500);
  });
});
