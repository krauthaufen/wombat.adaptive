// Port of `[AList] reference impl` property test from F#'s AList.fs.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { AVal as RealAVal } from "../src/adaptiveValue/adaptiveValue.js";
import { AVal as RefAVal } from "../src/reference/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { arbVList, type VList } from "./utilities/generators.js";

function diffContent(v: VList<number>): string | null {
  const r = v.lreal.getReader();
  r.getChanges(AdaptiveToken.top);
  const real = RealAVal.force(v.lreal.content);
  const ref = RefAVal.force(v.lref.content);

  const realArr = [...real];
  const refArr = [...ref];
  if (
    realArr.length !== refArr.length ||
    realArr.some((x, i) => x !== refArr[i])
  ) {
    return `mismatch:\n  real: [${realArr.join(",")}]\n  ref:  [${refArr.join(",")}]`;
  }
  return null;
}

describe("[AList] reference impl", () => {
  test("real and reference agree under random mutations", () => {
    fc.assert(
      fc.property(
        arbVList({ size: 8 }).chain((v) =>
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
              `initial divergence in expression\n${v.lexpression}\n${initial}`,
            );
          }

          for (const seed of stepSeeds) {
            const all = v.lchanges();
            if (all.length === 0) break;

            const subsetArb = fc
              .subarray(all, { minLength: 1 })
              .chain((subset) =>
                fc.tuple(...subset.map((c) => c.change)).map((m) => m),
              );
            const mutators = fc.sample(subsetArb, { numRuns: 1, seed })[0]!;

            transact(() => {
              for (const m of mutators) m();
            });

            const d = diffContent(v);
            if (d !== null) {
              throw new Error(
                `divergence after mutation in expression\n${v.lexpression}\n${d}`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: 500 },
    );
    expect(true).toBe(true);
  });
});
