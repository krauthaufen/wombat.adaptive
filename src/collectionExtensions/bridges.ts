// Cross-collection bridge readers + combinators from
// FSharp.Data.Adaptive/CollectionExtensions.fs.
//
//   ASet.toAList / sortBy / sortByDescending / sortWith / sort /
//   sortDescending / groupBy / toAMapIgnoreDuplicates
//   AList.toASet / mapToASet / toASetIndexed / ofASet / toAMap /
//   ofAMap / groupBy
//   AMap.toAList / ofAList / sortBy / sortByDescending
//
// PORT NOTE: the F# tree-builder readers (`ListTreeReader`,
// `SetTreeReader`) are not ported here — they're heavy
// dirty-reader machinery used by the rarely-touched
// `ASet.ofListTree` / `ASet.ofSetTree` and depend on cycle-free
// inputs that are easier to add later if needed.

import { AVal, type aval } from "../adaptiveValue/adaptiveValue.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import { Index, indexZero } from "../datastructures/index.js";
import { IndexList } from "../datastructures/indexList.js";
import {
  IndexListDelta,
} from "../datastructures/indexListDelta.js";
import { MapExt } from "../datastructures/mapExt.js";
import {
  HashMap,
  HashSet,
} from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import {
  type ElementOperation,
  ElementSet,
  ElementRemove,
  SetOperation,
} from "../datastructures/operations.js";
import { Cache } from "../utilities/cache.js";
import { Unique } from "../utilities/unique.js";
import { IndexMapping } from "../utilities/indexMapping.js";
import {
  AbstractReader,
  AbstractStatefulReader,
  type IOpReader,
  type IOpReaderWithState,
} from "../traceable/history.js";
import { hashMapTrace } from "../traceable/hashMapTraceable.js";
import { indexListTrace } from "../traceable/indexListTraceable.js";

import {
  ASet as ASetOps,
  type aset,
} from "../adaptiveHashSet/adaptiveHashSet.js";
import {
  AMap as AMapOps,
  type amap,
} from "../adaptiveHashMap/adaptiveHashMap.js";
import {
  AList as AListOps,
  type alist,
} from "../adaptiveIndexList/adaptiveIndexList.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const indexCmp = (a: Index, b: Index): number => a.compareTo(b);

function indexListOfSeqIndexed<T>(
  seq: Iterable<readonly [Index, T]>,
): IndexList<T> {
  return IndexList.fromMap(
    MapExt.ofSeq<Index, T>(seq as Iterable<[Index, T]>, indexCmp),
  );
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Reader for `ASet.sortBy` / `sortByDescending`. */
class SetSortByReader<T1, T2> extends AbstractReader<IndexListDelta<T1>> {
  private readonly _reader: IOpReaderWithState<unknown, HashSetDelta<T1>>;
  private readonly _cache: Cache<T1, Unique<T2>>;
  private readonly _mapping: IndexMapping<Unique<T2>>;
  constructor(
    set: aset<T1>,
    projection: (t: T1) => T2,
    cmp: (a: T2, b: T2) => number,
  ) {
    super(IndexListDelta.empty<T1>());
    this._reader = set.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<T1>
    >;
    this._cache = new Cache<T1, Unique<T2>>((v) => new Unique(projection(v), cmp));
    this._mapping = new IndexMapping<Unique<T2>>((a, b) => a.compareTo(b));
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T1> {
    let delta = IndexListDelta.empty<T1>();
    for (const op of this._reader.getChanges(tok)) {
      if (op.count === 1) {
        const k = this._cache.invoke(op.value);
        const idx = this._mapping.invoke(k);
        delta = delta.add(idx, ElementSet(op.value));
      } else if (op.count === -1) {
        const k = this._cache.tryRevoke(op.value);
        if (k !== undefined) {
          const idx = this._mapping.revoke(k);
          if (idx !== undefined) delta = delta.add(idx, ElementRemove);
        }
      }
    }
    return delta;
  }
}

/** Reader for `ASet.sortWith`. */
class SetSortWithReader<T> extends AbstractReader<IndexListDelta<T>> {
  private readonly _reader: IOpReaderWithState<unknown, HashSetDelta<T>>;
  private readonly _mapping: IndexMapping<T>;
  constructor(set: aset<T>, compare: (a: T, b: T) => number) {
    super(IndexListDelta.empty<T>());
    this._reader = set.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<T>
    >;
    this._mapping = new IndexMapping<T>(compare);
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    let delta = IndexListDelta.empty<T>();
    for (const op of this._reader.getChanges(tok)) {
      if (op.count === 1) {
        const idx = this._mapping.invoke(op.value);
        delta = delta.add(idx, ElementSet(op.value));
      } else if (op.count === -1) {
        const idx = this._mapping.revoke(op.value);
        if (idx !== undefined) delta = delta.add(idx, ElementRemove);
      }
    }
    return delta;
  }
}

/** Reader for `AList.toASet`. */
class ListSetReader<T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _reader: IOpReaderWithState<IndexList<T>, IndexListDelta<T>>;
  constructor(list: alist<T>) {
    super(HashSetDelta.empty<T>());
    this._reader = list.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    const old = this._reader.state;
    const changes = this._reader.getChanges(tok);
    let delta = HashSetDelta.empty<T>();
    for (const [i, op] of changes) {
      if (op.tag === "Remove") {
        const v = old.tryGetByIndex(i);
        if (v !== undefined)
          delta = delta.combine(HashSetDelta.single(SetOperation.rem(v)));
      } else {
        const ov = old.tryGetByIndex(i);
        if (ov !== undefined) {
          if (!Object.is(op.value, ov)) {
            delta = delta.combine(HashSetDelta.single(SetOperation.add(op.value)));
            delta = delta.combine(HashSetDelta.single(SetOperation.rem(ov)));
          }
        } else {
          delta = delta.combine(HashSetDelta.single(SetOperation.add(op.value)));
        }
      }
    }
    return delta;
  }
}

/** Reader for `AList.mapToASet`. */
class ListSetMapReader<T1, T2> extends AbstractReader<HashSetDelta<T2>> {
  private readonly _reader: IOpReaderWithState<
    IndexList<T1>,
    IndexListDelta<T1>
  >;
  private readonly _cache: Cache<T1, T2>;
  constructor(list: alist<T1>, mapping: (t: T1) => T2) {
    super(HashSetDelta.empty<T2>());
    this._reader = list.getReader();
    this._cache = new Cache<T1, T2>(mapping);
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T2> {
    const old = this._reader.state;
    const changes = this._reader.getChanges(tok);
    let delta = HashSetDelta.empty<T2>();
    for (const [i, op] of changes) {
      if (op.tag === "Remove") {
        const v = old.tryGetByIndex(i);
        if (v !== undefined) {
          const vv = this._cache.tryRevoke(v);
          if (vv !== undefined)
            delta = delta.combine(HashSetDelta.single(SetOperation.rem(vv)));
        }
      } else {
        const ov = old.tryGetByIndex(i);
        if (ov !== undefined) {
          if (!Object.is(op.value, ov)) {
            delta = delta.combine(
              HashSetDelta.single(SetOperation.add(this._cache.invoke(op.value))),
            );
            const o = this._cache.tryRevoke(ov);
            if (o !== undefined)
              delta = delta.combine(HashSetDelta.single(SetOperation.rem(o)));
          }
        } else {
          delta = delta.combine(
            HashSetDelta.single(SetOperation.add(this._cache.invoke(op.value))),
          );
        }
      }
    }
    return delta;
  }
}

/** Reader for `AList.toASetIndexed`. */
class IndexedListSetReader<T> extends AbstractReader<HashSetDelta<[Index, T]>> {
  private readonly _reader: IOpReaderWithState<IndexList<T>, IndexListDelta<T>>;
  constructor(list: alist<T>) {
    super(HashSetDelta.empty<[Index, T]>());
    this._reader = list.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<[Index, T]> {
    const old = this._reader.state;
    const changes = this._reader.getChanges(tok);
    let delta = HashSetDelta.empty<[Index, T]>();
    for (const [i, op] of changes) {
      if (op.tag === "Remove") {
        const v = old.tryGetByIndex(i);
        if (v !== undefined)
          delta = delta.combine(
            HashSetDelta.single(SetOperation.rem<[Index, T]>([i, v])),
          );
      } else {
        const ov = old.tryGetByIndex(i);
        if (ov !== undefined) {
          if (!Object.is(op.value, ov)) {
            delta = delta.combine(
              HashSetDelta.single(SetOperation.add<[Index, T]>([i, op.value])),
            );
            delta = delta.combine(
              HashSetDelta.single(SetOperation.rem<[Index, T]>([i, ov])),
            );
          }
        } else {
          delta = delta.combine(
            HashSetDelta.single(SetOperation.add<[Index, T]>([i, op.value])),
          );
        }
      }
    }
    return delta;
  }
}

/** Reader for `ASet.toAList`. */
class ToListReader<T> extends AbstractReader<IndexListDelta<T>> {
  private readonly _reader: IOpReaderWithState<unknown, HashSetDelta<T>>;
  private _last: Index;
  private readonly _newIndex: Cache<T, Index>;
  constructor(input: aset<T>) {
    super(IndexListDelta.empty<T>());
    this._reader = input.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<T>
    >;
    // Mirrors F#: `let mutable last = Index.zero;
    //              let newIndex _v = let i = Index.after last; last <- i; i`
    this._last = indexZero;
    this._newIndex = new Cache<T, Index>((_v) => {
      const i = this._last.after();
      this._last = i;
      return i;
    });
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    let delta = IndexListDelta.empty<T>();
    for (const d of this._reader.getChanges(tok)) {
      if (d.count === 1) {
        const i = this._newIndex.invoke(d.value);
        delta = delta.add(i, ElementSet(d.value));
      } else if (d.count === -1) {
        const i = this._newIndex.revokeUnsafe(d.value);
        delta = delta.add(i, ElementRemove);
      }
    }
    return delta;
  }
}

/** Reader for `AMap.toAList` (over `amap<Index, V>`). */
class MapToListReader<T> extends AbstractStatefulReader<
  IndexList<T>,
  IndexListDelta<T>
> {
  private readonly _reader: IOpReaderWithState<
    HashMap<Index, T>,
    HashMapDelta<Index, T>
  >;
  constructor(input: amap<Index, T>) {
    super(indexListTrace<T>());
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): IndexListDelta<T> {
    const ops = this._reader.getChanges(tok);
    let m = MapExt.empty<Index, ElementOperation<T>>(indexCmp);
    for (const [k, op] of ops) m = m.add(k, op);
    return IndexListDelta.ofMap(m);
  }
}

/** Reader for `AList.toAMap` (`alist<T>` → `amap<Index, T>`). */
class ListToMapReader<T> extends AbstractStatefulReader<
  HashMap<Index, T>,
  HashMapDelta<Index, T>
> {
  private readonly _reader: IOpReaderWithState<IndexList<T>, IndexListDelta<T>>;
  constructor(input: alist<T>) {
    super(hashMapTrace<Index, T>());
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashMapDelta<Index, T> {
    const ops = this._reader.getChanges(tok);
    let out = HashMap.empty<Index, ElementOperation<T>>();
    for (const [k, op] of ops) out = out.add(k, op);
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `AMap.sortBy` / `AMap.sortByDescending`. */
class MapSortByReader<K, V, T> extends AbstractReader<
  IndexListDelta<[K, V]>
> {
  private readonly _reader: IOpReaderWithState<HashMap<K, V>, HashMapDelta<K, V>>;
  private readonly _projection: (k: K, v: V) => T;
  // Map<K, [id, projected]>
  private _state: HashMap<K, [number, T]> = HashMap.empty<K, [number, T]>();
  private _currentId = 0;
  private readonly _mapping: IndexMapping<[number, T]>;
  constructor(
    map: amap<K, V>,
    cmp: (a: T, b: T) => number,
    projection: (k: K, v: V) => T,
  ) {
    super(IndexListDelta.empty<[K, V]>());
    this._reader = map.getReader();
    this._projection = projection;
    this._mapping = new IndexMapping<[number, T]>(([k0, t0], [k1, t1]) => {
      const c = cmp(t0, t1);
      if (c !== 0) return c;
      return k0 - k1;
    });
  }
  private _newId(): number {
    const i = this._currentId;
    this._currentId = i + 1;
    return i;
  }
  override compute(tok: AdaptiveToken): IndexListDelta<[K, V]> {
    let res = MapExt.empty<Index, ElementOperation<[K, V]>>(indexCmp);
    for (const [key, op] of this._reader.getChanges(tok)) {
      if (op.tag === "Set") {
        const cur = this._state.tryFind(key);
        let id: number;
        if (cur !== undefined) {
          id = cur[0];
          // Revoke the previous projection so its old output index is
          // released; otherwise the mapping retains a stale entry at
          // the old `[id, t_old]` slot and the downstream IndexList
          // ends up with duplicate output entries for `key`.
          const oldIdx = this._mapping.revoke(cur);
          if (oldIdx !== undefined) res = res.add(oldIdx, ElementRemove);
        } else {
          id = this._newId();
        }
        const t = this._projection(key, op.value);
        const index = this._mapping.invoke([id, t]);
        res = res.add(index, ElementSet<[K, V]>([key, op.value]));
        this._state = this._state.add(key, [id, t]);
      } else {
        const cur = this._state.tryFind(key);
        if (cur !== undefined) {
          this._state = this._state.remove(key);
          const idx = this._mapping.revoke(cur);
          if (idx !== undefined) res = res.add(idx, ElementRemove);
        }
      }
    }
    return IndexListDelta.ofMap(res);
  }
}

/** Reader for `AMap.keys` (HashMapDelta → HashSetDelta of keys). */
class MapKeysReader<K, V> extends AbstractReader<HashSetDelta<K>> {
  private readonly _reader: IOpReaderWithState<HashMap<K, V>, HashMapDelta<K, V>>;
  constructor(map: amap<K, V>) {
    super(HashSetDelta.empty<K>());
    this._reader = map.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<K> {
    const old = this._reader.state;
    const ops = this._reader.getChanges(tok);
    let out = HashMap.empty<K, number>();
    for (const [key, op] of ops) {
      if (op.tag === "Set") {
        if (!old.containsKey(key)) out = out.add(key, 1);
      } else {
        if (old.containsKey(key)) out = out.add(key, -1);
      }
    }
    return HashSetDelta.ofHashMap(out);
  }
}

// ---------------------------------------------------------------------------
// AMap bridges
// ---------------------------------------------------------------------------

export const AMapBridges = {
  /** `amap<K,V>` → `aset<K>`. (Re-exported from CollectionExtensions; here for completeness.) */
  keys<K, V>(map: amap<K, V>): aset<K> {
    if (map.isConstant) {
      return ASetOps.constant<K>(() => AVal.force(map.content).getKeys());
    }
    return ASetOps.ofReader<K>(() => new MapKeysReader<K, V>(map));
  },

  /** `amap<Index, V>` → `alist<V>`. */
  toAList<V>(map: amap<Index, V>): alist<V> {
    if (map.isConstant) {
      return AListOps.ofIndexList(
        indexListOfSeqIndexed<V>(AVal.force(map.content).toList()),
      );
    }
    if (map.history !== undefined) {
      const hist = map.history;
      return AListOps.ofReader<V>(
        () =>
          hist.newViewReader<IndexList<V>, IndexListDelta<V>>(
            indexListTrace<V>(),
            (_state, delta) => {
              let m = MapExt.empty<Index, ElementOperation<V>>(indexCmp);
              for (const [k, op] of delta) m = m.add(k, op);
              return IndexListDelta.ofMap(m);
            },
          ) as IOpReader<IndexListDelta<V>>,
      );
    }
    return AListOps.ofReader<V>(() => new MapToListReader<V>(map));
  },

  /** `alist<T>` → `amap<Index, T>`. */
  ofAList<T>(list: alist<T>): amap<Index, T> {
    if (list.isConstant) {
      return AMapOps.ofHashMap(
        HashMap.ofSeq([...AListOps.force(list).toListIndexed()]),
      );
    }
    if (list.history !== undefined) {
      const hist = list.history;
      return AMapOps.ofReader<Index, T>(
        () =>
          hist.newViewReader<HashMap<Index, T>, HashMapDelta<Index, T>>(
            hashMapTrace<Index, T>(),
            (_state, delta) => {
              let out = HashMap.empty<Index, ElementOperation<T>>();
              for (const [k, op] of delta) out = out.add(k, op);
              return HashMapDelta.ofHashMap(out);
            },
          ) as IOpReader<HashMapDelta<Index, T>>,
      );
    }
    return AMapOps.ofReader<Index, T>(() => new ListToMapReader<T>(list));
  },

  /** Sorted `alist<[K,V]>` by `projection k v`. */
  sortBy<K, V, T>(
    projection: (k: K, v: V) => T,
    map: amap<K, V>,
    compare?: (a: T, b: T) => number,
  ): alist<[K, V]> {
    const cmp =
      compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
    if (map.isConstant) {
      const arr = [...AVal.force(map.content)].slice();
      arr.sort(([k1, v1], [k2, v2]) => {
        const c = cmp(projection(k1, v1), projection(k2, v2));
        if (c !== 0) return c;
        return 0;
      });
      return AListOps.ofList<[K, V]>(arr.map(([k, v]) => [k, v] as [K, V]));
    }
    return AListOps.ofReader<[K, V]>(
      () => new MapSortByReader<K, V, T>(map, cmp, projection),
    );
  },

  /** Sorted descending. */
  sortByDescending<K, V, T>(
    projection: (k: K, v: V) => T,
    map: amap<K, V>,
    compare?: (a: T, b: T) => number,
  ): alist<[K, V]> {
    const baseCmp =
      compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
    return AMapBridges.sortBy<K, V, T>(projection, map, (a, b) => baseCmp(b, a));
  },
};

// ---------------------------------------------------------------------------
// ASet bridges
// ---------------------------------------------------------------------------

export const ASetBridges = {
  /** `amap<K, V>` → `aset<KeyValuePair<K, V>>`. */
  ofAMap<K, V>(map: amap<K, V>) {
    return AMapOps.toASet(map);
  },
  /** `amap<K, V>` → `aset<V>` (distinct values). */
  ofAMapValues<K, V>(map: amap<K, V>): aset<V> {
    return AMapOps.toASetValues(map);
  },

  /** `alist<T>` → `aset<T>` (set of values, undefined order). */
  ofAList<T>(list: alist<T>): aset<T> {
    if (list.isConstant) {
      return ASetOps.constant<T>(() =>
        HashSet.ofSeq(AVal.force(list.content)),
      );
    }
    return ASetOps.ofReader<T>(() => new ListSetReader<T>(list));
  },

  /** `alist<T>` → `aset<[Index, T]>`. */
  ofAListIndexed<T>(list: alist<T>): aset<[Index, T]> {
    if (list.isConstant) {
      return ASetOps.constant<[Index, T]>(() =>
        HashSet.ofSeq([...AVal.force(list.content).toListIndexed()]),
      );
    }
    return ASetOps.ofReader<[Index, T]>(
      () => new IndexedListSetReader<T>(list),
    );
  },

  /** `aset<K>` + mapping → `amap<K, V>`. */
  mapToAMap<K, V>(mapping: (k: K) => V, set: aset<K>): amap<K, V> {
    return AMapOps.mapSet(mapping, set);
  },

  /** Sort with custom comparator. Returns alist. */
  sortWith<T>(
    compare: (a: T, b: T) => number,
    set: aset<T>,
  ): alist<T> {
    if (set.isConstant) {
      return AListOps.ofSeq([...AVal.force(set.content)].sort(compare));
    }
    return AListOps.ofReader<T>(() => new SetSortWithReader<T>(set, compare));
  },

  /** Sort by projection. */
  sortBy<T1, T2>(
    projection: (t: T1) => T2,
    set: aset<T1>,
    compare?: (a: T2, b: T2) => number,
  ): alist<T1> {
    const cmp =
      compare ?? ((a: T2, b: T2) => (a < b ? -1 : a > b ? 1 : 0));
    if (set.isConstant) {
      const arr = [...AVal.force(set.content)].slice();
      arr.sort((a, b) => cmp(projection(a), projection(b)));
      return AListOps.ofSeq(arr);
    }
    return AListOps.ofReader<T1>(
      () => new SetSortByReader<T1, T2>(set, projection, cmp),
    );
  },

  sort<T>(set: aset<T>): alist<T> {
    return ASetBridges.sortWith<T>((a, b) => (a < b ? -1 : a > b ? 1 : 0), set);
  },
  sortDescending<T>(set: aset<T>): alist<T> {
    return ASetBridges.sortWith<T>((a, b) => (b < a ? -1 : b > a ? 1 : 0), set);
  },
  sortByDescending<T1, T2>(
    projection: (t: T1) => T2,
    set: aset<T1>,
    compare?: (a: T2, b: T2) => number,
  ): alist<T1> {
    const base = compare ?? ((a: T2, b: T2) => (a < b ? -1 : a > b ? 1 : 0));
    return ASetBridges.sortBy<T1, T2>(projection, set, (a, b) => base(b, a));
  },

  /** `aset<T>` → `alist<T>` with undefined element order. */
  toAList<T>(set: aset<T>): alist<T> {
    if (set.isConstant) {
      return AListOps.ofSeq([...AVal.force(set.content)]);
    }
    return AListOps.ofReader<T>(() => new ToListReader<T>(set));
  },

  /** Group set elements by `mapping` into `amap<K, HashSet<T>>`. */
  groupBy<T, K>(mapping: (t: T) => K, set: aset<T>): amap<K, HashSet<T>> {
    return AMapOps.ofASetMapped<K, T>(mapping, set);
  },

  /** Map set elements to keys with collisions ignored. */
  toAMapIgnoreDuplicates<T, K>(
    getKey: (t: T) => K,
    set: aset<T>,
  ): amap<K, T> {
    return AMapOps.ofASetMappedIgnoreDuplicates<K, T>(getKey, set);
  },
};

// ---------------------------------------------------------------------------
// AList bridges (most are aliases of the ASet/AMap variants)
// ---------------------------------------------------------------------------

export const AListBridges = {
  /** `alist<T>` → `aset<T>`. */
  toASet<T>(list: alist<T>): aset<T> {
    return ASetBridges.ofAList(list);
  },

  /** `alist<T>` → `aset<T'>` mapping each element. */
  mapToASet<T1, T2>(mapping: (t: T1) => T2, list: alist<T1>): aset<T2> {
    if (list.isConstant) {
      return ASetOps.constant<T2>(() =>
        HashSet.ofSeq([...AVal.force(list.content)].map(mapping)),
      );
    }
    return ASetOps.ofReader<T2>(
      () => new ListSetMapReader<T1, T2>(list, mapping),
    );
  },

  /** `alist<T>` → `aset<[Index, T]>`. */
  toASetIndexed<T>(list: alist<T>): aset<[Index, T]> {
    return ASetBridges.ofAListIndexed(list);
  },

  /** `aset<T>` → `alist<T>` with undefined order. */
  ofASet<T>(set: aset<T>): alist<T> {
    return ASetBridges.toAList(set);
  },

  /** `alist<T>` → `amap<Index, T>`. */
  toAMap<T>(list: alist<T>): amap<Index, T> {
    return AMapBridges.ofAList(list);
  },

  /** `amap<Index, T>` → `alist<T>`. */
  ofAMap<T>(map: amap<Index, T>): alist<T> {
    return AMapBridges.toAList(map);
  },

  /** Group an alist by `mapping` into `amap<K, IndexList<T>>`. */
  groupBy<T, K>(
    mapping: (t: T) => K,
    list: alist<T>,
  ): amap<K, IndexList<T>> {
    // F# implements: list |> mapi (fun i v -> mapping v, (i, v))
    //                |> toASet
    //                |> AMap.ofASet
    //                |> AMap.map (fun _ v -> IndexList.ofSeqIndexed v)
    //
    // Our `AMap.ofASet` requires `aset<KeyValuePair<K, V>>` (because
    // structural equality on TS array tuples doesn't exist), so we
    // build the pairs as `KeyValuePair` instances directly.
    type Entry = { i: Index; v: T };
    const entrySet = AListBridges.mapToASet<T, [K, Entry]>((v) => {
      // Note: we don't have access to the index here. Use mapi+ofASet
      // chain instead.
      return [mapping(v), { i: undefined as unknown as Index, v }] as [K, Entry];
    }, list);
    void entrySet;

    // Cleaner: pair-set → KeyValuePair grouping → map values.
    const indexed = AListOps.mapi<T, { k: K; entry: Entry }>(
      (i, v) => ({ k: mapping(v), entry: { i, v } }),
      list,
    );
    const asSet = AListBridges.toASet<{ k: K; entry: Entry }>(indexed);
    const grouped = AMapOps.ofASetMapped<K, { k: K; entry: Entry }>(
      (x) => x.k,
      asSet,
    );
    return AMapOps.map<K, HashSet<{ k: K; entry: Entry }>, IndexList<T>>(
      (_k, vs) =>
        indexListOfSeqIndexed<T>(
          [...vs].map((x) => [x.entry.i, x.entry.v] as [Index, T]),
        ),
      grouped,
    );
  },
};
