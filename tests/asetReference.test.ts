// Port of FSharp.Data.Adaptive.Tests/ASet.fs `[ASet] reference impl`.
//
// Property test: generate a random ASet expression tree (real + reference
// implementations driven in lockstep), run a sequence of random
// mutations under a transaction, then assert that the real adaptive
// content equals the reference content after each step.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { AVal as RealAVal } from "../src/adaptiveValue/adaptiveValue.js";
import { AVal as RefAVal } from "../src/reference/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";
import { arbVSet, type VSet } from "./utilities/generators.js";

/** Pull the real reader once, then compare real-content vs. ref-content. */
function diffContent(v: VSet<number>): string | null {
  const r = v.sreal.getReader();
  r.getChanges(AdaptiveToken.top);
  const realSet = RealAVal.force(v.sreal.content);
  const refSet = RefAVal.force(v.sref.content);

  const realArr = [...realSet].sort((a, b) => a - b);
  const refArr = [...refSet].sort((a, b) => a - b);
  if (
    realArr.length !== refArr.length ||
    realArr.some((x, i) => x !== refArr[i])
  ) {
    return `mismatch:\n  real: [${realArr.join(",")}]\n  ref:  [${refArr.join(",")}]`;
  }
  return null;
}

describe("[ASet] reference impl", () => {
  test("real and reference agree under random mutations", () => {
    fc.assert(
      fc.property(
        arbVSet({ size: 8 }).chain((v) =>
          fc
            .array(fc.integer({ min: 0, max: 0x7fffffff }), {
              minLength: 1,
              maxLength: 8,
            })
            .map((stepSeeds) => ({ v, stepSeeds })),
        ),
        ({ v, stepSeeds }) => {
          // Initial pull — must agree before any mutation.
          const initial = diffContent(v);
          if (initial !== null) {
            throw new Error(
              `initial divergence in expression\n${v.sexpression}\n${initial}`,
            );
          }

          for (const seed of stepSeeds) {
            const all = v.schanges();
            if (all.length === 0) break;

            // Subset of the available changes (>= 1) to apply this step.
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
                `divergence after mutation in expression\n${v.sexpression}\n${diff}`,
              );
            }
          }
          return true;
        },
      ),
      { numRuns: 500, verbose: false },
    );
  });
});
