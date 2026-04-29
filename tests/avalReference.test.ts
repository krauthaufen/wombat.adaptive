// Property-based reference test for the AVal layer alone.
// Uses `arbVVal` from the shared generators (which already drives
// real + reference impls in lockstep) and runs random mutation
// transactions, asserting `AVal.force(real) === AVal.force(ref)`
// after each step.

import { describe, expect, test } from "vitest";
import * as fc from "fast-check";

import { AVal as RealAVal } from "../src/adaptiveValue/adaptiveValue.js";
import { AVal as RefAVal } from "../src/reference/adaptiveValue.js";
import { transact } from "../src/core/transaction.js";
import { arbVVal, type VVal } from "./utilities/generators.js";

function diff(v: VVal<number>): string | null {
  const r = RealAVal.force(v.real);
  const f = RefAVal.force(v.ref);
  if (!Object.is(r, f)) return `mismatch: real=${r} ref=${f}`;
  return null;
}

describe("[AVal] reference impl", () => {
  test("real and reference agree under random mutations", () => {
    fc.assert(
      fc.property(
        arbVVal({ size: 8 }).chain((v) =>
          fc
            .array(fc.integer({ min: 0, max: 0x7fffffff }), {
              minLength: 1,
              maxLength: 8,
            })
            .map((stepSeeds) => ({ v, stepSeeds })),
        ),
        ({ v, stepSeeds }) => {
          const initial = diff(v);
          if (initial !== null) {
            throw new Error(
              `initial divergence in expression\n${v.expression}\n${initial}`,
            );
          }
          for (const seed of stepSeeds) {
            const all = v.changes();
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

            const d = diff(v);
            if (d !== null) {
              throw new Error(
                `divergence after mutation in expression\n${v.expression}\n${d}`,
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
