// Port of FSharp.Data.Adaptive.Tests/AMap.fs `[AMap] reference impl`.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { AVal as RealAVal } from "../src/adaptiveValue/adaptiveValue.js";
import { AVal as RefAVal } from "../src/reference/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { arbVMap, type VMap } from "./utilities/generators.js";

function diffContent(v: VMap<number, number>): string | null {
  const r = v.mreal.getReader();
  r.getChanges(AdaptiveToken.top);
  const real = RealAVal.force(v.mreal.content);
  const ref = RefAVal.force(v.mref.content);

  const realArr = [...real]
    .map(([k, val]) => `${k}=${val}`)
    .sort();
  const refArr = [...ref]
    .map(([k, val]) => `${k}=${val}`)
    .sort();
  if (
    realArr.length !== refArr.length ||
    realArr.some((x, i) => x !== refArr[i])
  ) {
    return `mismatch:\n  real: [${realArr.join(",")}]\n  ref:  [${refArr.join(",")}]`;
  }
  return null;
}

describe("[AMap] reference impl", () => {
  test("real and reference agree under random mutations", () => {
    fc.assert(
      fc.property(
        arbVMap({ size: 8 }).chain((v) =>
          fc
            .array(fc.integer({ min: 0, max: 0x7fffffff }), {
              minLength: 1,
              maxLength: 8,
            })
            .map((stepSeeds) => ({ v, stepSeeds })),
        ),
        ({ v, stepSeeds }) => {
          const initial = diffContent(v);
          if (initial !== null) {
            throw new Error(
              `initial divergence in expression\n${v.mexpression}\n${initial}`,
            );
          }

          for (const seed of stepSeeds) {
            const all = v.mchanges();
            if (all.length === 0) break;

            const subsetArb = fc
              .subarray(all, { minLength: 1 })
              .chain((subset) =>
                fc
                  .tuple(...subset.map((c) => c.change))
                  .map((mutators) => mutators),
              );
            const mutators = fc.sample(subsetArb, { numRuns: 1, seed })[0]!;

            transact(() => {
              for (const m of mutators) m();
            });

            const diff = diffContent(v);
            if (diff !== null) {
              throw new Error(
                `divergence after mutation in expression\n${v.mexpression}\n${diff}`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: 500, verbose: false },
    );
    expect(true).toBe(true);
  });
});
