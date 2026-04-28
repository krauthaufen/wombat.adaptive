// Port of FSharp.Data.Adaptive Datastructures/HashMapDelta.fs

import { HashMap } from "./hashCollections.js";
import type { ElementOperation } from "./operations.js";

/// Represents the difference of two HashMaps.
export class HashMapDelta<K, V> implements Iterable<[K, ElementOperation<V>]> {
  private readonly _store: HashMap<K, ElementOperation<V>>;

  /** @internal */
  constructor(store: HashMap<K, ElementOperation<V>>) {
    this._store = store;
  }

  /// The internal store used by the HashMapDelta.
  get store(): HashMap<K, ElementOperation<V>> {
    return this._store;
  }

  get isEmpty(): boolean {
    return this._store.isEmpty;
  }

  get count(): number {
    return this._store.count;
  }

  /// Combines two HashMapDeltas to one.
  combine(other: HashMapDelta<K, V>): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(this._store.unionWith(other._store));
  }

  *[Symbol.iterator](): IterableIterator<[K, ElementOperation<V>]> {
    for (const e of this._store) yield e;
  }

  toString(): string {
    const items = this._store
      .toList()
      .slice(0, 5)
      .map(([k, op]) => {
        if (op.tag === "Set") return `[${String(k)}]<-${String(op.value)}`;
        return `Rem(${String(k)})`;
      })
      .join("; ");
    return `HashMapDelta [${items}${this.count > 5 ? "; ..." : ""}]`;
  }

  equals(other: HashMapDelta<K, V>): boolean {
    if (this._store.count !== other._store.count) return false;
    for (const [k, op] of this._store) {
      const o = other._store.tryFind(k);
      if (o === undefined && !other._store.containsKey(k)) return false;
      if (op.tag !== o!.tag) return false;
      if (op.tag === "Set" && o!.tag === "Set") {
        if (!Object.is(op.value, o!.value)) return false;
      }
    }
    return true;
  }

  static empty<K, V>(): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(HashMap.empty<K, ElementOperation<V>>());
  }

  static single<K, V>(
    key: K,
    value: ElementOperation<V>,
  ): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(HashMap.single(key, value));
  }

  static ofHashMap<K, V>(
    elements: HashMap<K, ElementOperation<V>>,
  ): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(elements);
  }

  static ofSeq<K, V>(
    elements: Iterable<[K, ElementOperation<V>]>,
  ): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(HashMap.ofSeq(elements));
  }

  static ofList<K, V>(
    elements: Array<[K, ElementOperation<V>]>,
  ): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(HashMap.ofList(elements));
  }

  static ofArray<K, V>(
    elements: Array<[K, ElementOperation<V>]>,
  ): HashMapDelta<K, V> {
    return new HashMapDelta<K, V>(HashMap.ofArray(elements));
  }
}

export const HashMapDeltaOps = {
  empty: <K, V>() => HashMapDelta.empty<K, V>(),
  single: <K, V>(k: K, v: ElementOperation<V>) => HashMapDelta.single(k, v),
  ofHashMap: <K, V>(m: HashMap<K, ElementOperation<V>>) =>
    HashMapDelta.ofHashMap(m),
  ofSeq: <K, V>(s: Iterable<[K, ElementOperation<V>]>) => HashMapDelta.ofSeq(s),
  ofList: <K, V>(s: Array<[K, ElementOperation<V>]>) => HashMapDelta.ofList(s),
  ofArray: <K, V>(s: Array<[K, ElementOperation<V>]>) => HashMapDelta.ofArray(s),
  isEmpty: <K, V>(m: HashMapDelta<K, V>) => m.isEmpty,
  count: <K, V>(m: HashMapDelta<K, V>) => m.count,
  toSeq: <K, V>(m: HashMapDelta<K, V>): Iterable<[K, ElementOperation<V>]> => m,
  toList: <K, V>(m: HashMapDelta<K, V>) => [...m],
  toArray: <K, V>(m: HashMapDelta<K, V>) => [...m],
  toHashMap: <K, V>(m: HashMapDelta<K, V>) => m.store,
  combine: <K, V>(l: HashMapDelta<K, V>, r: HashMapDelta<K, V>) => l.combine(r),
};
