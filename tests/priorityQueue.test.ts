// Port of FSharp.Data.Adaptive.Tests/PriorityQueue.fs

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";
import { heapDequeue, heapEnqueue, TransactQueue } from "../src/utilities/priorityQueue.js";

const compareInt = (a: number, b: number) => a - b;

describe("[Heap]", () => {
  test("sorting", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 10000 }), (values) => {
        const heap: number[] = [];
        for (const v of values) heapEnqueue(heap, compareInt, v);
        expect(heap.length).toBe(values.length);

        const sorted = [...values].sort(compareInt);
        const out: number[] = [];
        for (let i = 0; i < sorted.length; i++) {
          out.push(heapDequeue(heap, compareInt));
        }
        expect(out).toEqual(sorted);
      }),
      { numRuns: 200 },
    );
  });

  test("enqueue", () => {
    fc.assert(
      fc.property(fc.array(fc.integer(), { maxLength: 10000 }), (values) => {
        const heap: number[] = [];
        for (const v of values) heapEnqueue(heap, compareInt, v);
        expect(heap.length).toBe(values.length);

        const validateHeapOrder = (i: number): void => {
          const li = 2 * i + 1;
          const ri = 2 * i + 2;
          if (li < heap.length) {
            expect(heap[i]!).toBeLessThanOrEqual(heap[li]!);
            validateHeapOrder(li);
          }
          if (ri < heap.length) {
            expect(heap[i]!).toBeLessThanOrEqual(heap[ri]!);
            validateHeapOrder(ri);
          }
        };
        if (heap.length > 0) validateHeapOrder(0);
      }),
      { numRuns: 200 },
    );
  });
});

// Basic sanity tests for TransactQueue (the F# test file has none specific
// to TransactQueue; covered indirectly by Transaction tests). Add minimal
// direct coverage so this primitive is independently green.
describe("TransactQueue", () => {
  test("dedup: enqueueing the same reference twice is a no-op", () => {
    const q = new TransactQueue<{ id: number }>();
    const a = { id: 1 };
    q.enqueue(5, a);
    q.enqueue(7, a);
    expect(q.contains(a)).toBe(true);
    const r = q.dequeue();
    expect(r.key).toBe(5);
    expect(r.value).toBe(a);
    expect(q.isEmpty).toBe(true);
  });

  test("dequeue order is by ascending key", () => {
    const q = new TransactQueue<{ id: number }>();
    const items = [
      { v: { id: 1 }, k: 5 },
      { v: { id: 2 }, k: 1 },
      { v: { id: 3 }, k: 10 },
      { v: { id: 4 }, k: 3 },
    ];
    for (const { v, k } of items) q.enqueue(k, v);
    const keys: number[] = [];
    while (!q.isEmpty) keys.push(q.dequeue().key);
    expect(keys).toEqual([1, 3, 5, 10]);
  });

  test("contains reflects state", () => {
    const q = new TransactQueue<{ id: number }>();
    const a = { id: 1 };
    expect(q.contains(a)).toBe(false);
    q.enqueue(0, a);
    expect(q.contains(a)).toBe(true);
    q.dequeue();
    expect(q.contains(a)).toBe(false);
  });
});
