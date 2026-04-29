// Port of FSharp.Data.Adaptive Utilities.Unique.
//
// Wraps a value with a unique monotonic id so that two structurally
// equal values have distinct identity. Used by ASet→AList sorting
// readers to disambiguate equal projection results when assigning
// stable output indices via `IndexMapping`.

let _uniqueIdCounter = 0;

export class Unique<T> {
  readonly value: T;
  /** @internal */
  readonly _id: number;
  private readonly _cmp: (a: T, b: T) => number;

  constructor(value: T, cmp: (a: T, b: T) => number) {
    this.value = value;
    this._cmp = cmp;
    _uniqueIdCounter = (_uniqueIdCounter + 1) | 0;
    this._id = _uniqueIdCounter;
  }

  /** Compare by (value, id). Stable: equal values fall back to id order. */
  compareTo(o: Unique<T>): number {
    const c = this._cmp(this.value, o.value);
    if (c !== 0) return c;
    return this._id - o._id;
  }

  toString(): string {
    return String(this.value);
  }
}
