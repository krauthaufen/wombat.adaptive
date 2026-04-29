// Port of FSharp.Data.Adaptive Utilities.RangeDelta.
//
// Splits the change between two integer ranges into four disjoint
// regions: max-side increase / decrease, min-side decrease / increase.
// Used by `AList.range` to emit minimal Add/Remove deltas as the
// bounds shift, instead of rebuilding the whole list.

export interface RangeChangeRegions {
  /** [low, high] — inclusive range of values to APPEND on the
   *  max side (max moved up). Empty if `low > high`. */
  readonly maxIncrease: readonly [number, number];
  /** [low, high] — inclusive range of values to REMOVE on the
   *  max side (max moved down). Iterated DOWN: low ≥ high. */
  readonly maxDecrease: readonly [number, number];
  /** [low, high] — inclusive range of values to PREPEND on the
   *  min side (min moved down). Iterated DOWN: low ≥ high. */
  readonly minDecrease: readonly [number, number];
  /** [low, high] — inclusive range of values to REMOVE on the
   *  min side (min moved up). Empty if `low > high`. */
  readonly minIncrease: readonly [number, number];
}

/**
 * Determines the four delta regions when an integer range
 * `[lastMin, lastMax]` shifts to `[newMin, newMax]`. Mirrors
 * `RangeDelta.rangeChange` from F#.
 */
export function rangeChange(
  lastMin: number,
  lastMax: number,
  newMin: number,
  newMax: number,
): RangeChangeRegions {
  const maxIncreaseLow = Math.max(newMin, lastMax + 1);
  const maxIncreaseHigh = newMax;
  const maxIncrease: readonly [number, number] = [
    maxIncreaseLow,
    maxIncreaseHigh,
  ];

  const maxDecreaseLow = lastMax;
  const maxDecreaseHigh = Math.max(newMax + 1, lastMin);
  const maxDecrease: readonly [number, number] = [
    maxDecreaseLow,
    maxDecreaseHigh,
  ];

  let minDecreaseLow = Math.min(newMax, lastMin - 1);
  // Prevent double insertion after max increase.
  if (newMax > lastMax) {
    minDecreaseLow = Math.min(minDecreaseLow, maxIncrease[0] - 1);
  }
  const minDecrease: readonly [number, number] = [minDecreaseLow, newMin];

  let minIncreaseHigh = Math.min(newMin - 1, lastMax);
  // Prevent double removal after max decrease.
  if (newMax < lastMax) {
    minIncreaseHigh = Math.min(minIncreaseHigh, maxDecrease[1] - 1);
  }
  const minIncrease: readonly [number, number] = [lastMin, minIncreaseHigh];

  return { maxIncrease, maxDecrease, minDecrease, minIncrease };
}
