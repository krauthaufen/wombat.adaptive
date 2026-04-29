// Port of FSharp.Data.Adaptive.Reference/AdaptiveHashMap.fs

import { HashMap, HashSet } from "../datastructures/hashCollections.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { HashMapDeltaExt } from "../datastructures/deltas.js";
import {
  AVal,
  AdaptiveToken,
  type aval,
} from "./adaptiveValue.js";
import {
  type IOpReader,
  type IOpReaderWithState,
  type aset,
} from "./adaptiveHashSet.js";

/** The reference implementation for IHashMapReader. */
export type IHashMapReader<K, V> = IOpReaderWithState<
  HashMap<K, V>,
  HashMapDelta<K, V>
>;

/** The reference implementation for amap. */
export interface amap<K, V> {
  getReader(): IHashMapReader<K, V>;
  readonly content: aval<HashMap<K, V>>;
}

/** A simple reader using `HashMap.computeDelta` for getting deltas. */
class AMapReader<K, V> implements IHashMapReader<K, V> {
  private _last: HashMap<K, V> = HashMap.empty<K, V>();
  private readonly _set: amap<K, V>;
  constructor(set: amap<K, V>) {
    this._set = set;
  }
  get state(): HashMap<K, V> {
    return this._last;
  }
  getChanges(t: AdaptiveToken): HashMapDelta<K, V> {
    const c = this._set.content.getValue(t);
    const ops = HashMapDeltaExt.computeDelta<K, V>(this._last, c);
    this._last = c;
    return ops;
  }
}

/** A reference implementation for cmap. */
export class ChangeableHashMap<K, V> implements amap<K, V> {
  private _content: HashMap<K, V>;
  readonly content: aval<HashMap<K, V>>;

  constructor(value?: HashMap<K, V> | Iterable<[K, V]>) {
    this._content =
      value === undefined
        ? HashMap.empty<K, V>()
        : value instanceof HashMap
          ? value
          : HashMap.ofSeq<K, V>(value);
    this.content = { getValue: () => this._content };
  }

  get isEmpty(): boolean {
    return this._content.isEmpty;
  }
  get count(): number {
    return this._content.count;
  }
  containsKey(key: K): boolean {
    return this._content.containsKey(key);
  }

  get(key: K): V | undefined {
    return this._content.tryFind(key);
  }
  set(key: K, value: V): void {
    this._content = this._content.add(key, value);
  }

  /** Adds the given key/value to the map; returns whether the key was new. */
  add(key: K, value: V): boolean {
    const w = this._content.containsKey(key);
    this._content = this._content.add(key, value);
    return !w;
  }

  /** Removes the given key; returns whether the element existed. */
  remove(key: K): boolean {
    const w = this._content.containsKey(key);
    this._content = this._content.remove(key);
    return w;
  }

  clear(): void {
    this._content = HashMap.empty<K, V>();
  }

  get value(): HashMap<K, V> {
    return this._content;
  }
  set value(v: HashMap<K, V>) {
    this._content = v;
  }

  getReader(): IHashMapReader<K, V> {
    return new AMapReader<K, V>(this);
  }
}

export type cmap<K, V> = ChangeableHashMap<K, V>;

function ofRef<K, V>(r: aval<HashMap<K, V>>): amap<K, V> {
  const self: amap<K, V> = {
    content: r,
    getReader: () => new AMapReader<K, V>(self),
  };
  return self;
}

function asetOfRef<T>(r: aval<HashSet<T>>): aset<T> {
  // Re-implementing the inline `ASet.ofRef` here to avoid circular imports.
  const self: aset<T> = {
    content: r,
    getReader: () => {
      let last: HashSet<T> = HashSet.empty<T>();
      const reader: IOpReader<HashSetDelta<T>> & { state: HashSet<T> } = {
        get state() {
          return last;
        },
        getChanges: (t: AdaptiveToken) => {
          const c = self.content.getValue(t);
          const ops = HashSetDelta.ofHashMap(
            last.computeDeltaAsHashMapStd(c),
          );
          last = c;
          return ops;
        },
      };
      return reader;
    },
  };
  return self;
}

/** Functional operators for the amap reference-implementation. */
export const AMap = {
  /** The empty amap. */
  empty<K, V>(): amap<K, V> {
    return ofRef(AVal.constant(HashMap.empty<K, V>()));
  },
  single<K, V>(key: K, value: V): amap<K, V> {
    return ofRef(AVal.constant(HashMap.single(key, value)));
  },
  ofSeq<K, V>(values: Iterable<[K, V]>): amap<K, V> {
    return ofRef(AVal.constant(HashMap.ofSeq(values)));
  },
  ofList<K, V>(values: Array<[K, V]>): amap<K, V> {
    return ofRef(AVal.constant(HashMap.ofList(values)));
  },
  ofArray<K, V>(values: Array<[K, V]>): amap<K, V> {
    return ofRef(AVal.constant(HashMap.ofArray(values)));
  },
  ofHashMap<K, V>(values: HashMap<K, V>): amap<K, V> {
    return ofRef(AVal.constant(values));
  },
  toAVal<K, V>(set: amap<K, V>): aval<HashMap<K, V>> {
    return set.content;
  },
  map<K, V, T>(mapping: (k: K, v: V) => T, set: amap<K, V>): amap<K, T> {
    return ofRef(AVal.map((s) => s.map(mapping), set.content));
  },
  mapValue<K, V, T>(mapping: (v: V) => T, set: amap<K, V>): amap<K, T> {
    return AMap.map((_k, v) => mapping(v), set);
  },
  mapSet<K, V>(mapping: (k: K) => V, set: aset<K>): amap<K, V> {
    return ofRef(
      AVal.map((s) => {
        let out = HashMap.empty<K, V>();
        for (const k of s) out = out.add(k, mapping(k));
        return out;
      }, set.content),
    );
  },
  choose<K, V, T>(
    mapping: (k: K, v: V) => T | undefined,
    set: amap<K, V>,
  ): amap<K, T> {
    return ofRef(AVal.map((s) => s.choose(mapping), set.content));
  },
  chooseValue<K, V, T>(
    mapping: (v: V) => T | undefined,
    set: amap<K, V>,
  ): amap<K, T> {
    return AMap.choose((_k, v) => mapping(v), set);
  },
  filter<K, V>(
    predicate: (k: K, v: V) => boolean,
    set: amap<K, V>,
  ): amap<K, V> {
    return ofRef(AVal.map((s) => s.filter(predicate), set.content));
  },
  filterValue<K, V>(predicate: (v: V) => boolean, set: amap<K, V>): amap<K, V> {
    return AMap.filter((_k, v) => predicate(v), set);
  },
  choose2<K, V1, V2, T>(
    mapping: (k: K, v1: V1 | undefined, v2: V2 | undefined) => T | undefined,
    l: amap<K, V1>,
    r: amap<K, V2>,
  ): amap<K, T> {
    return ofRef(
      AVal.map2((lm, rm) => lm.choose2V<V2, T>(rm, mapping), l.content, r.content),
    );
  },
  unionWith<K, V>(
    resolve: (k: K, l: V, r: V) => V,
    l: amap<K, V>,
    r: amap<K, V>,
  ): amap<K, V> {
    return ofRef(AVal.map2((a, b) => a.unionWith(b, resolve), l.content, r.content));
  },
  union<K, V>(l: amap<K, V>, r: amap<K, V>): amap<K, V> {
    return AMap.unionWith<K, V>((_k, _l, r) => r, l, r);
  },
  ofAVal<K, V>(value: aval<Iterable<[K, V]>>): amap<K, V> {
    return ofRef(AVal.map((v) => HashMap.ofSeq(v), value));
  },
  bind<T, K, V>(mapping: (t: T) => amap<K, V>, value: aval<T>): amap<K, V> {
    return ofRef(AVal.bind((v) => mapping(v).content, value));
  },
  toASet<K, V>(value: amap<K, V>): aset<[K, V]> {
    return asetOfRef(
      AVal.map((v) => HashSet.ofSeq<[K, V]>([...v]), value.content),
    );
  },
};

void AdaptiveToken;
