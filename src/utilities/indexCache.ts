// Per-index cache used by AList readers. Mirrors F#'s
// `IndexCache<'a, 'b>` (Utilities.fs).
//
// `invokeAndGetOld(i, a)` returns the new mapped value for `(i, a)`;
// if a previous mapping for `i` existed:
//   - and the input `a` is structurally equal to the old one, the
//     cached result is reused and `oldValue` is `undefined`;
//   - otherwise the function is recomputed, the new entry overwrites
//     the old, and `oldValue` is the previously cached result.
// `revoke(i)` drops the entry, returning the cached result if any.
//
// Equality is `defaultEquals` from `equality.ts`, so user-defined
// `equals` / `getHashCode` are honoured.

import type { Index } from "../datastructures/index.js";
import { defaultEquals } from "../datastructures/equality.js";
import { HashTable } from "./hashTable.js";

interface IndexEntry<A, B> {
  readonly a: A;
  readonly b: B;
}

export class IndexCache<A, B> {
  private readonly _f: (i: Index, a: A) => B;
  private readonly _store: HashTable<Index, IndexEntry<A, B>> =
    new HashTable<Index, IndexEntry<A, B>>();
  private readonly _release: (b: B) => void;

  constructor(f: (i: Index, a: A) => B, release: (b: B) => void = () => {}) {
    this._f = f;
    this._release = release;
  }

  /**
   * Returns `[oldValue?, newValue]`. When the input `a` is structurally
   * equal to the cached input for index `i`, the call is a no-op and
   * `oldValue` is `undefined`. Otherwise the mapping is recomputed,
   * the entry is replaced, and `oldValue` is the previous mapped
   * result.
   */
  invokeAndGetOld(i: Index, a: A): { oldValue: B | undefined; newValue: B } {
    const existing = this._store.get(i);
    if (existing !== undefined) {
      if (defaultEquals(existing.a, a)) {
        return { oldValue: undefined, newValue: existing.b };
      }
      const res = this._f(i, a);
      this._store.set(i, { a, b: res });
      return { oldValue: existing.b, newValue: res };
    }
    const res = this._f(i, a);
    this._store.set(i, { a, b: res });
    return { oldValue: undefined, newValue: res };
  }

  /** Drops the entry for `i`, returning its cached value if any. */
  revoke(i: Index): B | undefined {
    const existing = this._store.get(i);
    if (existing === undefined) return undefined;
    this._store.delete(i);
    this._release(existing.b);
    return existing.b;
  }

  clear(): void {
    for (const e of this._store.values()) this._release(e.b);
    this._store.clear();
  }
}
