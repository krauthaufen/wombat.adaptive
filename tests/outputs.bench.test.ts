// A graph of many small fan-outs, as views of many similar items build: each
// source cell is read by three others. Registering those outputs is part of
// every evaluation; the time is printed ([bench]), the result checked.
import { describe, expect, test } from "vitest";
import { AVal, cval, transact } from "../src/index.js";

describe("output registration", () => {
  test("50k cells read by three each", () => {
    const n = 50000;
    const run = () => {
      const srcs = Array.from({ length: n }, (_, i) => cval(i));
      const outs = srcs.flatMap((s) => [s.map((x: number) => x + 1), s.map((x: number) => x * 2), s.map((x: number) => x - 1)]);
      const all = AVal.custom((t) => { let sum = 0; for (const o of outs) sum += o.getValue(t); return sum; });
      const t0 = performance.now();
      const v0 = AVal.force(all);
      const t1 = performance.now();
      transact(() => { for (const s of srcs) s.value = s.value + 1; });
      const v1 = AVal.force(all);
      const t2 = performance.now();
      return { v0, v1, build: t1 - t0, change: t2 - t1 };
    };
    run();
    const r = run();
    // sum of (i+1) + 2i + (i-1) = 4i, over i < n; each +1 adds 4 per source
    expect(r.v0).toBe(4 * (n * (n - 1)) / 2);
    expect(r.v1).toBe(r.v0 + 4 * n);
    console.log(`[bench] ${n} cells x 3 outputs: first evaluation ${r.build.toFixed(0)} ms, all changed ${r.change.toFixed(0)} ms`);
  });
});
