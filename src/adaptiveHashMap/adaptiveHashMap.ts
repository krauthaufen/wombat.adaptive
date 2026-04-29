// Port of FSharp.Data.Adaptive AdaptiveHashMap/AdaptiveHashMap.fs
//
// PORT NOTE: structurally mirrors adaptiveHashSet.ts. The optimization
// where `map.history` exists and the reader is built via
// `history.newViewReader(trace, deltaMapping)` is preserved.
//
// PORT NOTE: `mapUse` is omitted (no IDisposable in JS, mirrors ASet).
// `intersectV` (struct tuple) is collapsed into `intersect` since
// JS arrays already are value-tuples.
//
// PORT NOTE: `toASet` returns `aset<KeyValuePair<K, V>>` rather than
// `aset<[K, V]>`. F#'s `'Key * 'Value` tuples have structural equality
// but JS array-tuples do not, which would make the downstream
// CountingHashSet treat every `[k, v]` as a distinct identity. The
// `KeyValuePair` class implements `equals(other)` / `getHashCode()`
// so it works correctly with the equality convention from
// `equality.ts`.

import {
  AVal,
  type aval,
  delay as avalDelay,
  constant as avalConstant,
} from "../adaptiveValue/adaptiveValue.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import type { IAdaptiveObject } from "../core/types.js";
import {
  HashMap,
  HashSet,
} from "../datastructures/hashCollections.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import {
  type ElementOperation,
  ElementSet,
  ElementRemove,
  SetOperation,
} from "../datastructures/operations.js";
import { Cache } from "../utilities/cache.js";
import { defaultEquals, defaultHash } from "../datastructures/equality.js";
import { MultiSetMap } from "../datastructures/multiSetMap.js";
import { hashMapTrace } from "../traceable/hashMapTraceable.js";
import {
  AbstractDirtyReader,
  AbstractReader,
  AbstractStatefulReader,
  ConstantReader,
  EmptyReader,
  History,
  type IOpReader,
  type IOpReaderWithState,
} from "../traceable/history.js";
import { HashMapDeltaExt } from "../datastructures/deltas.js";
import {
  ASet as ASetOps,
  type aset,
} from "../adaptiveHashSet/adaptiveHashSet.js";
import type { AdaptiveReduction } from "../adaptiveValue/adaptiveReduction.js";
import * as Reductions from "../adaptiveValue/adaptiveReduction.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * An adaptive reader for `amap` that allows pulling operations and
 * exposes its current state.
 */
export type IHashMapReader<K, V> = IOpReaderWithState<
  HashMap<K, V>,
  HashMapDelta<K, V>
>;

/** Adaptive map datastructure. */
export interface amap<K, V> {
  /** Is the map constant? */
  readonly isConstant: boolean;
  /** Current content of the map as `aval`. */
  readonly content: aval<HashMap<K, V>>;
  /** Gets a new reader to the map. */
  getReader(): IHashMapReader<K, V>;
  /** The underlying History instance for the amap (if any). */
  readonly history: History<HashMap<K, V>, HashMapDelta<K, V>> | undefined;
}

/** Convenience: pull the current content of an amap (untracked). */
export function force<K, V>(map: amap<K, V>): HashMap<K, V> {
  return AVal.force(map.content);
}

/**
 * A pair of key + value with structural equality. Used by `toASet` so
 * that downstream `CountingHashSet` operations see two pairs with the
 * same key+value as the same element. Hash combines the key/value via
 * `defaultHash`.
 */
export class KeyValuePair<K, V> {
  constructor(
    readonly key: K,
    readonly value: V,
  ) {}
  equals(other: unknown): boolean {
    if (!(other instanceof KeyValuePair)) return false;
    const o = other as KeyValuePair<K, V>;
    return defaultEquals(this.key, o.key) && defaultEquals(this.value, o.value);
  }
  getHashCode(): number {
    const a = defaultHash(this.key) | 0;
    const b = defaultHash(this.value) | 0;
    return (Math.imul(a, 0x9e3779b1) ^ b) | 0;
  }
}

// ---------------------------------------------------------------------------
// Empty / Constant / impl wrappers
// ---------------------------------------------------------------------------

class EmptyAmap<K, V> implements amap<K, V> {
  readonly isConstant = true;
  readonly content: aval<HashMap<K, V>> = avalConstant(HashMap.empty<K, V>());
  readonly history = undefined;
  private static _cached: EmptyAmap<unknown, unknown> | null = null;
  static instance<K, V>(): amap<K, V> {
    if (!EmptyAmap._cached)
      EmptyAmap._cached = new EmptyAmap<unknown, unknown>();
    return EmptyAmap._cached as unknown as amap<K, V>;
  }
  getReader(): IHashMapReader<K, V> {
    return new EmptyReader<HashMap<K, V>, HashMapDelta<K, V>>(
      hashMapTrace<K, V>(),
    );
  }
}

class ConstantAmap<K, V> implements amap<K, V> {
  readonly isConstant = true;
  private readonly _create: () => HashMap<K, V>;
  private _cached: HashMap<K, V> | null = null;
  readonly content: aval<HashMap<K, V>>;
  readonly history = undefined;
  constructor(create: () => HashMap<K, V>) {
    this._create = create;
    this.content = avalDelay(() => this.lazy());
  }
  private lazy(): HashMap<K, V> {
    if (this._cached === null) this._cached = this._create();
    return this._cached;
  }
  getReader(): IHashMapReader<K, V> {
    return new ConstantReader<HashMap<K, V>, HashMapDelta<K, V>>(
      hashMapTrace<K, V>(),
      () =>
        HashMapDeltaExt.computeDelta<K, V>(
          HashMap.empty<K, V>(),
          this.lazy(),
        ),
      () => this.lazy(),
    );
  }
}

class AdaptiveHashMapImpl<K, V> implements amap<K, V> {
  readonly isConstant = false;
  readonly history: History<HashMap<K, V>, HashMapDelta<K, V>>;
  readonly content: aval<HashMap<K, V>>;

  constructor(
    createReader: () => IOpReader<HashMapDelta<K, V>>,
  ) {
    this.history = History.ofReader<HashMap<K, V>, HashMapDelta<K, V>>(
      hashMapTrace<K, V>(),
      createReader,
    );
    this.content = AVal.custom((tok) => {
      this.history.getValue(tok);
      return this.history.state;
    });
  }

  getReader(): IHashMapReader<K, V> {
    return this.history.newReader();
  }
}

function constant<K, V>(create: () => HashMap<K, V>): amap<K, V> {
  return new ConstantAmap<K, V>(create);
}

function ofReaderInternal<K, V>(
  createReader: () => IOpReader<HashMapDelta<K, V>>,
): amap<K, V> {
  return new AdaptiveHashMapImpl<K, V>(createReader);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

/** Reader for `map` (key-aware). */
class MapWithKeyReader<K, V1, V2> extends AbstractReader<HashMapDelta<K, V2>> {
  private readonly _reader: IHashMapReader<K, V1>;
  private readonly _mapping: (k: K, v: V1) => V2;
  constructor(input: amap<K, V1>, mapping: (k: K, v: V1) => V2) {
    super(HashMapDelta.empty<K, V2>());
    this._reader = input.getReader();
    this._mapping = mapping;
  }
  static deltaMapping<K, V1, V2>(
    mapping: (k: K, v: V1) => V2,
  ): (state: HashMap<K, V1>, ops: HashMapDelta<K, V1>) => HashMapDelta<K, V2> {
    return (_state, ops) => {
      const out = ops.store.map<ElementOperation<V2>>((k, op) =>
        op.tag === "Set" ? ElementSet(mapping(k, op.value)) : ElementRemove,
      );
      return HashMapDelta.ofHashMap(out);
    };
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V2> {
    const ops = this._reader.getChanges(tok);
    const out = ops.store.map<ElementOperation<V2>>((k, op) =>
      op.tag === "Set" ? ElementSet(this._mapping(k, op.value)) : ElementRemove,
    );
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `map'` (value-only, with cache). */
class MapValueReader<K, V1, V2> extends AbstractReader<HashMapDelta<K, V2>> {
  private readonly _reader: IHashMapReader<K, V1>;
  private readonly _cache: Cache<V1, V2>;
  constructor(input: amap<K, V1>, mapping: (v: V1) => V2) {
    super(HashMapDelta.empty<K, V2>());
    this._reader = input.getReader();
    this._cache = new Cache<V1, V2>(mapping);
  }
  static deltaMapping<K, V1, V2>(
    mapping: (v: V1) => V2,
  ): (state: HashMap<K, V1>, ops: HashMapDelta<K, V1>) => HashMapDelta<K, V2> {
    const cache = new Cache<V1, V2>(mapping);
    return (state, ops) => {
      const out = ops.store.choose<ElementOperation<V2>>((k, op) => {
        if (op.tag === "Set") return ElementSet(cache.invoke(op.value));
        // Remove
        const old = state.tryFind(k);
        if (old !== undefined) cache.tryRevoke(old);
        return ElementRemove;
      });
      return HashMapDelta.ofHashMap(out);
    };
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V2> {
    const oldState = this._reader.state;
    const ops = this._reader.getChanges(tok);
    const out = ops.store.choose<ElementOperation<V2>>((k, op) => {
      if (op.tag === "Set") return ElementSet(this._cache.invoke(op.value));
      const old = oldState.tryFind(k);
      if (old !== undefined) this._cache.tryRevoke(old);
      return ElementRemove;
    });
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `choose` (key-aware). */
class ChooseWithKeyReader<K, V1, V2> extends AbstractReader<HashMapDelta<K, V2>> {
  private readonly _reader: IHashMapReader<K, V1>;
  private readonly _mapping: (k: K, v: V1) => V2 | undefined;
  private readonly _living = new Set<K>();
  constructor(
    input: amap<K, V1>,
    mapping: (k: K, v: V1) => V2 | undefined,
  ) {
    super(HashMapDelta.empty<K, V2>());
    this._reader = input.getReader();
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V2> {
    const ops = this._reader.getChanges(tok);
    const out = ops.store.choose<ElementOperation<V2>>((k, op) => {
      if (op.tag === "Set") {
        const r = this._mapping(k, op.value);
        if (r !== undefined) {
          this._living.add(k);
          return ElementSet(r);
        }
        if (this._living.delete(k)) return ElementRemove;
        return undefined;
      }
      // Remove
      if (this._living.delete(k)) return ElementRemove;
      return undefined;
    });
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `choose'` (value-only, with cache). */
class ChooseReader<K, V1, V2> extends AbstractReader<HashMapDelta<K, V2>> {
  private readonly _reader: IHashMapReader<K, V1>;
  private readonly _cache: Cache<V1, V2 | undefined>;
  private readonly _living = new Set<K>();
  constructor(input: amap<K, V1>, f: (v: V1) => V2 | undefined) {
    super(HashMapDelta.empty<K, V2>());
    this._reader = input.getReader();
    this._cache = new Cache<V1, V2 | undefined>(f);
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V2> {
    const oldState = this._reader.state;
    const ops = this._reader.getChanges(tok);
    const out = ops.store.choose<ElementOperation<V2>>((k, op) => {
      if (op.tag === "Set") {
        const r = this._cache.invoke(op.value);
        if (r !== undefined) {
          this._living.add(k);
          return ElementSet(r);
        }
        const old = oldState.tryFind(k);
        if (old !== undefined) {
          this._living.delete(k);
          this._cache.tryRevoke(old);
          return ElementRemove;
        }
        return undefined;
      }
      // Remove
      if (this._living.delete(k)) return ElementRemove;
      return undefined;
    });
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `choose2V`. */
class Choose2VReader<K, A, B, T> extends AbstractReader<HashMapDelta<K, T>> {
  private readonly _l: IHashMapReader<K, A>;
  private readonly _r: IHashMapReader<K, B>;
  private readonly _mapping: (
    k: K,
    a: A | undefined,
    b: B | undefined,
  ) => T | undefined;
  constructor(
    mapping: (k: K, a: A | undefined, b: B | undefined) => T | undefined,
    l: amap<K, A>,
    r: amap<K, B>,
  ) {
    super(HashMapDelta.empty<K, T>());
    this._l = l.getReader();
    this._r = r.getReader();
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, T> {
    const lops = this._l.getChanges(tok);
    const rops = this._r.getChanges(tok);
    const merge = (
      key: K,
      lop: ElementOperation<A> | undefined,
      rop: ElementOperation<B> | undefined,
    ): ElementOperation<T> | undefined => {
      let lv: A | undefined;
      if (lop === undefined) lv = this._l.state.tryFind(key);
      else if (lop.tag === "Set") lv = lop.value;
      else lv = undefined;

      let rv: B | undefined;
      if (rop === undefined) rv = this._r.state.tryFind(key);
      else if (rop.tag === "Set") rv = rop.value;
      else rv = undefined;

      // Both undefined → mapping not relevant; emit Remove guard.
      if (lv === undefined && rv === undefined) return ElementRemove;
      const res = this._mapping(key, lv, rv);
      if (res !== undefined) return ElementSet(res);
      return ElementRemove;
    };
    const out = lops.store.choose2V<ElementOperation<B>, ElementOperation<T>>(
      rops.store,
      merge,
    );
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `mapA`. */
class MapAReader<K, A, B>
  extends AbstractDirtyReader<aval<B>, HashMapDelta<K, B>>
{
  private readonly _reader: IHashMapReader<K, A>;
  private readonly _mapping: (k: K, a: A) => aval<B>;
  private readonly _cache: Cache<readonly [K, A], aval<B>>;
  private _targets: MultiSetMap<aval<B>, K> = MultiSetMap.empty<aval<B>, K>();
  constructor(input: amap<K, A>, mapping: (k: K, a: A) => aval<B>) {
    super({ mempty: HashMapDelta.empty<K, B>() }, (tag) => tag !== "input");
    this._reader = input.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "input";
    this._mapping = mapping;
    this._cache = new Cache<readonly [K, A], aval<B>>((arg) =>
      this._mapping(arg[0], arg[1]),
    );
  }
  override compute(tok: AdaptiveToken, dirty: Set<aval<B>>): HashMapDelta<K, B> {
    const old = this._reader.state;
    const ops = this._reader.getChanges(tok);

    let changes = HashMap.empty<K, ElementOperation<B>>();
    for (const [i, op] of ops) {
      // Whether this index was independently dirty: clear it.
      // (We can't directly remove by key from the dirty set; we track
      //  via cache invalidation below.)
      if (op.tag === "Set") {
        const o = old.tryFind(i);
        if (o !== undefined) {
          const revoked = this._cache.tryRevoke([i, o]);
          if (revoked !== undefined) {
            const rem = MultiSetMap.remove(revoked, i, this._targets);
            this._targets = rem.result;
            if (rem.wasLast) revoked.outputs.remove(this);
          }
        }
        const k = this._cache.invoke([i, op.value]);
        const v = k.getValue(tok);
        this._targets = MultiSetMap.add(k, i, this._targets);
        changes = changes.add(i, ElementSet(v));
      } else {
        const v = old.tryFind(i);
        if (v !== undefined) {
          const revoked = this._cache.tryRevoke([i, v]);
          if (revoked !== undefined) {
            const rem = MultiSetMap.remove(revoked, i, this._targets);
            this._targets = rem.result;
            if (rem.wasLast) revoked.outputs.remove(this);
            changes = changes.add(i, ElementRemove);
          }
        }
      }
    }

    // Apply pure-aval-change-driven re-pulls (dirty avals not affected
    // by structural ops above).
    for (const d of dirty) {
      // Only avals in our targets matter.
      const indices = MultiSetMap.find(d, this._targets);
      for (const i of indices) {
        if (changes.containsKey(i)) continue;
        const v = d.getValue(tok);
        changes = changes.add(i, ElementSet(v));
      }
    }

    return HashMapDelta.ofHashMap(changes);
  }
}

/** Reader for `chooseA`. */
class ChooseAReader<K, A, B>
  extends AbstractDirtyReader<aval<B | undefined>, HashMapDelta<K, B>>
{
  private readonly _reader: IHashMapReader<K, A>;
  private readonly _mapping: (k: K, a: A) => aval<B | undefined>;
  private readonly _keys = new Set<K>();
  private readonly _cache: Cache<readonly [K, A], aval<B | undefined>>;
  private _targets: MultiSetMap<aval<B | undefined>, K> =
    MultiSetMap.empty<aval<B | undefined>, K>();
  constructor(
    input: amap<K, A>,
    mapping: (k: K, a: A) => aval<B | undefined>,
  ) {
    super({ mempty: HashMapDelta.empty<K, B>() }, (tag) => tag !== "input");
    this._reader = input.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "input";
    this._mapping = mapping;
    this._cache = new Cache<readonly [K, A], aval<B | undefined>>((arg) =>
      this._mapping(arg[0], arg[1]),
    );
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<aval<B | undefined>>,
  ): HashMapDelta<K, B> {
    const old = this._reader.state;
    const ops = this._reader.getChanges(tok);
    let changes = HashMap.empty<K, ElementOperation<B>>();
    for (const [i, op] of ops) {
      if (op.tag === "Set") {
        const o = old.tryFind(i);
        if (o !== undefined) {
          const revoked = this._cache.tryRevoke([i, o]);
          if (revoked !== undefined) {
            const rem = MultiSetMap.remove(revoked, i, this._targets);
            this._targets = rem.result;
            if (rem.wasLast) revoked.outputs.remove(this);
          }
        }
        const k = this._cache.invoke([i, op.value]);
        const v = k.getValue(tok);
        this._targets = MultiSetMap.add(k, i, this._targets);
        if (v !== undefined) {
          this._keys.add(i);
          changes = changes.add(i, ElementSet(v));
        } else if (this._keys.delete(i)) {
          changes = changes.add(i, ElementRemove);
        }
      } else {
        const v = old.tryFind(i);
        if (v !== undefined) {
          const revoked = this._cache.tryRevoke([i, v]);
          if (revoked !== undefined) {
            const rem = MultiSetMap.remove(revoked, i, this._targets);
            this._targets = rem.result;
            if (rem.wasLast) revoked.outputs.remove(this);
            if (this._keys.delete(i)) changes = changes.add(i, ElementRemove);
          }
        }
      }
    }
    for (const d of dirty) {
      const indices = MultiSetMap.find(d, this._targets);
      for (const i of indices) {
        if (changes.containsKey(i)) continue;
        const v = d.getValue(tok);
        if (v !== undefined) {
          this._keys.add(i);
          changes = changes.add(i, ElementSet(v));
        } else if (this._keys.delete(i)) {
          changes = changes.add(i, ElementRemove);
        }
      }
    }
    return HashMapDelta.ofHashMap(changes);
  }
}

/** Reader for `unionWith`. */
class UnionWithReader<K, V> extends AbstractReader<HashMapDelta<K, V>> {
  private readonly _l: IHashMapReader<K, V>;
  private readonly _r: IHashMapReader<K, V>;
  private readonly _resolve: (k: K, l: V, r: V) => V;
  constructor(
    l: amap<K, V>,
    r: amap<K, V>,
    resolve: (k: K, l: V, r: V) => V,
  ) {
    super(HashMapDelta.empty<K, V>());
    this._l = l.getReader();
    this._r = r.getReader();
    this._resolve = resolve;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V> {
    const lops = this._l.getChanges(tok);
    const rops = this._r.getChanges(tok);
    const merge = (
      key: K,
      lop: ElementOperation<V> | undefined,
      rop: ElementOperation<V> | undefined,
    ): ElementOperation<V> | undefined => {
      let lv: V | undefined;
      if (lop === undefined) lv = this._l.state.tryFind(key);
      else if (lop.tag === "Set") lv = lop.value;
      else lv = undefined;

      let rv: V | undefined;
      if (rop === undefined) rv = this._r.state.tryFind(key);
      else if (rop.tag === "Set") rv = rop.value;
      else rv = undefined;

      if (lv === undefined && rv === undefined) return ElementRemove;
      if (lv !== undefined && rv === undefined) return ElementSet(lv);
      if (lv === undefined && rv !== undefined) return ElementSet(rv);
      return ElementSet(this._resolve(key, lv as V, rv as V));
    };
    const out = lops.store.choose2V<ElementOperation<V>, ElementOperation<V>>(
      rops.store,
      merge,
    );
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `ofAVal`. */
class AValReader<K, V> extends AbstractStatefulReader<
  HashMap<K, V>,
  HashMapDelta<K, V>
> {
  private readonly _input: aval<Iterable<[K, V]>>;
  constructor(input: aval<Iterable<[K, V]>>) {
    super(hashMapTrace<K, V>());
    this._input = input;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V> {
    const next = HashMap.ofSeq(this._input.getValue(tok));
    return HashMapDeltaExt.computeDelta(this._state, next);
  }
}

/** Reader for `bind`. */
class BindReader<T, K, V> extends AbstractReader<HashMapDelta<K, V>> {
  private readonly _value: aval<T>;
  private readonly _mapping: (t: T) => amap<K, V>;
  private _old: { v: T; reader: IHashMapReader<K, V> } | null = null;
  constructor(value: aval<T>, mapping: (t: T) => amap<K, V>) {
    super(HashMapDelta.empty<K, V>());
    this._value = value;
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V> {
    const v = this._value.getValue(tok);
    if (this._old !== null && Object.is(this._old.v, v)) {
      return this._old.reader.getChanges(tok);
    }
    let rem = HashMap.empty<K, ElementOperation<V>>();
    if (this._old !== null) {
      const oldReader = this._old.reader;
      const removeDelta = HashMapDeltaExt.computeDelta(
        oldReader.state,
        HashMap.empty<K, V>(),
      );
      rem = removeDelta.store;
      (oldReader as unknown as IAdaptiveObject).outputs.remove(this);
    }
    const newMap = this._mapping(v);
    const newReader = newMap.getReader();
    this._old = { v, reader: newReader };
    const add = newReader.getChanges(tok);
    return HashMapDelta.ofHashMap(rem).combine(add);
  }
}

/** Reader for `toASet`. */
class ToASetReader<K, V> extends AbstractReader<HashSetDelta<KeyValuePair<K, V>>> {
  private readonly _reader: IHashMapReader<K, V>;
  constructor(input: amap<K, V>) {
    super(HashSetDelta.empty<KeyValuePair<K, V>>());
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<KeyValuePair<K, V>> {
    const oldState = this._reader.state;
    const ops = this._reader.getChanges(tok);
    let deltas = HashSetDelta.empty<KeyValuePair<K, V>>();
    for (const [k, op] of ops) {
      if (op.tag === "Set") {
        const oldValue = oldState.tryFind(k);
        if (oldValue !== undefined) {
          deltas = deltas.combine(
            HashSetDelta.single(SetOperation.rem(new KeyValuePair(k, oldValue))),
          );
        }
        deltas = deltas.combine(
          HashSetDelta.single(SetOperation.add(new KeyValuePair(k, op.value))),
        );
      } else {
        const ov = oldState.tryFind(k);
        if (ov !== undefined) {
          deltas = deltas.combine(
            HashSetDelta.single(SetOperation.rem(new KeyValuePair(k, ov))),
          );
        }
      }
    }
    return deltas;
  }
}

/** Reader for `toASetValues`. */
class ToValueASetReader<K, V> extends AbstractReader<HashSetDelta<V>> {
  private readonly _reader: IHashMapReader<K, V>;
  constructor(input: amap<K, V>) {
    super(HashSetDelta.empty<V>());
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<V> {
    const oldState = this._reader.state;
    const ops = this._reader.getChanges(tok);
    let deltas = HashSetDelta.empty<V>();
    for (const [k, op] of ops) {
      if (op.tag === "Set") {
        const oldValue = oldState.tryFind(k);
        if (oldValue !== undefined) {
          deltas = deltas.combine(HashSetDelta.single(SetOperation.rem(oldValue)));
        }
        deltas = deltas.combine(HashSetDelta.single(SetOperation.add(op.value)));
      } else {
        const ov = oldState.tryFind(k);
        if (ov !== undefined) {
          deltas = deltas.combine(HashSetDelta.single(SetOperation.rem(ov)));
        }
      }
    }
    return deltas;
  }
}

/** Reader for `mapSet`. */
class MapSetReader<K, V> extends AbstractReader<HashMapDelta<K, V>> {
  private readonly _reader: IOpReaderWithState<unknown, HashSetDelta<K>>;
  private readonly _mapping: (k: K) => V;
  constructor(set: aset<K>, mapping: (k: K) => V) {
    super(HashMapDelta.empty<K, V>());
    this._reader = set.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<K>
    >;
    this._mapping = mapping;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, V> {
    let out = HashMap.empty<K, ElementOperation<V>>();
    const delta = this._reader.getChanges(tok);
    for (const op of delta) {
      if (op.count > 0) out = out.add(op.value, ElementSet(this._mapping(op.value)));
      else if (op.count < 0) out = out.add(op.value, ElementRemove);
    }
    return HashMapDelta.ofHashMap(out);
  }
}

/**
 * Reader used for `ofASet`. Groups values into a HashSet per key, then
 * applies a view function (e.g. `id` for HashSet, `head` for "ignore
 * duplicates").
 */
class SetReader<K, V, View> extends AbstractReader<HashMapDelta<K, View>> {
  private readonly _reader: IOpReaderWithState<
    unknown,
    HashSetDelta<KeyValuePair<K, V>>
  >;
  private readonly _view: (s: HashSet<V>) => View;
  private readonly _state = new Map<K, HashSet<V>>();
  constructor(
    input: aset<KeyValuePair<K, V>>,
    view: (s: HashSet<V>) => View,
  ) {
    super(HashMapDelta.empty<K, View>());
    this._reader = input.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<KeyValuePair<K, V>>
    >;
    this._view = view;
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, View> {
    let out = HashMap.empty<K, ElementOperation<View>>();
    const delta = this._reader.getChanges(tok);
    for (const d of delta) {
      const k = d.value.key;
      const v = d.value.value;
      if (d.count === 1) {
        const set = this._state.get(k);
        const newSet =
          set === undefined ? HashSet.single(v) : set.add(v);
        this._state.set(k, newSet);
        out = out.add(k, ElementSet(this._view(newSet)));
      } else if (d.count === -1) {
        const set = this._state.get(k);
        if (set !== undefined) {
          const newSet = set.remove(v);
          if (newSet.isEmpty) {
            this._state.delete(k);
            out = out.add(k, ElementRemove);
          } else {
            this._state.set(k, newSet);
            out = out.add(k, ElementSet(this._view(newSet)));
          }
        }
      }
    }
    return HashMapDelta.ofHashMap(out);
  }
}

/** Reader for `ofASetMapped`. Like SetReader but derives keys via getKey. */
class MappedSetReader<K, V, View> extends AbstractReader<
  HashMapDelta<K, View>
> {
  private readonly _reader: IOpReaderWithState<unknown, HashSetDelta<V>>;
  private readonly _getKey: (v: V) => K;
  private readonly _view: (s: HashSet<V>) => View;
  private readonly _state = new Map<K, HashSet<V>>();
  private readonly _cache: Cache<V, K>;
  constructor(
    input: aset<V>,
    getKey: (v: V) => K,
    view: (s: HashSet<V>) => View,
  ) {
    super(HashMapDelta.empty<K, View>());
    this._reader = input.getReader() as unknown as IOpReaderWithState<
      unknown,
      HashSetDelta<V>
    >;
    this._getKey = getKey;
    this._view = view;
    this._cache = new Cache<V, K>(getKey);
  }
  override compute(tok: AdaptiveToken): HashMapDelta<K, View> {
    let out = HashMap.empty<K, ElementOperation<View>>();
    const delta = this._reader.getChanges(tok);
    for (const d of delta) {
      const v = d.value;
      if (d.count === 1) {
        const k = this._cache.invoke(v);
        const set = this._state.get(k);
        const newSet =
          set === undefined ? HashSet.single(v) : set.add(v);
        this._state.set(k, newSet);
        out = out.add(k, ElementSet(this._view(newSet)));
      } else if (d.count === -1) {
        const k = this._cache.tryRevoke(v);
        if (k !== undefined) {
          const set = this._state.get(k);
          if (set !== undefined) {
            const newSet = set.remove(v);
            if (newSet.isEmpty) {
              this._state.delete(k);
              out = out.add(k, ElementRemove);
            } else {
              this._state.set(k, newSet);
              out = out.add(k, ElementSet(this._view(newSet)));
            }
          }
        }
      }
    }
    return HashMapDelta.ofHashMap(out);
  }
}

// ---------------------------------------------------------------------------
// Module-level functions
// ---------------------------------------------------------------------------

export function empty<K, V>(): amap<K, V> {
  return EmptyAmap.instance<K, V>();
}

export function single<K, V>(key: K, value: V): amap<K, V> {
  return constant(() => HashMap.single(key, value));
}

export function ofSeq<K, V>(elements: Iterable<[K, V]>): amap<K, V> {
  return constant(() => HashMap.ofSeq(elements));
}
export function ofList<K, V>(elements: Array<[K, V]>): amap<K, V> {
  return constant(() => HashMap.ofList(elements));
}
export function ofArray<K, V>(elements: Array<[K, V]>): amap<K, V> {
  return constant(() => HashMap.ofArray(elements));
}
export function ofHashMap<K, V>(elements: HashMap<K, V>): amap<K, V> {
  return constant(() => elements);
}

export function ofAVal<K, V>(value: aval<Iterable<[K, V]>>): amap<K, V> {
  if (value.isConstant) {
    return constant(() => HashMap.ofSeq(AVal.force(value)));
  }
  return ofReaderInternal<K, V>(() => new AValReader<K, V>(value));
}

export function ofReader<K, V>(
  creator: () => IOpReader<HashMapDelta<K, V>>,
): amap<K, V> {
  return ofReaderInternal<K, V>(creator);
}

export function custom<K, V>(
  compute: (tok: AdaptiveToken, state: HashMap<K, V>) => HashMapDelta<K, V>,
): amap<K, V> {
  return ofReaderInternal<K, V>(() => {
    const trace = hashMapTrace<K, V>();
    class Custom extends AbstractStatefulReader<
      HashMap<K, V>,
      HashMapDelta<K, V>
    > {
      constructor() {
        super(trace);
      }
      override compute(tok: AdaptiveToken): HashMapDelta<K, V> {
        return compute(tok, this._state);
      }
      override applyOp(op: HashMapDelta<K, V>): HashMapDelta<K, V> {
        const r = HashMapDeltaExt.applyDelta(this._state, op);
        this._state = r.state;
        return r.delta;
      }
    }
    return new Custom();
  });
}

export function toAVal<K, V>(map: amap<K, V>): aval<HashMap<K, V>> {
  return map.content;
}

export function map<K, V1, V2>(
  mapping: (k: K, v: V1) => V2,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    return constant(() => force(m).map(mapping));
  }
  if (m.history !== undefined) {
    const hist = m.history;
    return ofReaderInternal<K, V2>(
      () =>
        hist.newViewReader<HashMap<K, V2>, HashMapDelta<K, V2>>(
          hashMapTrace<K, V2>(),
          MapWithKeyReader.deltaMapping<K, V1, V2>(mapping),
        ) as IOpReader<HashMapDelta<K, V2>>,
    );
  }
  return ofReaderInternal<K, V2>(() => new MapWithKeyReader<K, V1, V2>(m, mapping));
}

export function mapValue<K, V1, V2>(
  mapping: (v: V1) => V2,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    return constant(() => force(m).map((_k, v) => mapping(v)));
  }
  if (m.history !== undefined) {
    const hist = m.history;
    return ofReaderInternal<K, V2>(
      () =>
        hist.newViewReader<HashMap<K, V2>, HashMapDelta<K, V2>>(
          hashMapTrace<K, V2>(),
          MapValueReader.deltaMapping<K, V1, V2>(mapping),
        ) as IOpReader<HashMapDelta<K, V2>>,
    );
  }
  return ofReaderInternal<K, V2>(() => new MapValueReader<K, V1, V2>(m, mapping));
}

export function mapSet<K, V>(
  mapping: (k: K) => V,
  set: aset<K>,
): amap<K, V> {
  if (set.isConstant) {
    return constant(() => {
      let out = HashMap.empty<K, V>();
      for (const k of AVal.force(set.content)) out = out.add(k, mapping(k));
      return out;
    });
  }
  return ofReaderInternal<K, V>(() => new MapSetReader<K, V>(set, mapping));
}

export function choose<K, V1, V2>(
  mapping: (k: K, v: V1) => V2 | undefined,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    return constant(() => force(m).choose(mapping));
  }
  return ofReaderInternal<K, V2>(
    () => new ChooseWithKeyReader<K, V1, V2>(m, mapping),
  );
}

export function chooseValue<K, V1, V2>(
  mapping: (v: V1) => V2 | undefined,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    return constant(() => force(m).choose((_k, v) => mapping(v)));
  }
  return ofReaderInternal<K, V2>(
    () => new ChooseReader<K, V1, V2>(m, mapping),
  );
}

export function filter<K, V>(
  predicate: (k: K, v: V) => boolean,
  m: amap<K, V>,
): amap<K, V> {
  return choose<K, V, V>((k, v) => (predicate(k, v) ? v : undefined), m);
}

export function filterValue<K, V>(
  predicate: (v: V) => boolean,
  m: amap<K, V>,
): amap<K, V> {
  return chooseValue<K, V, V>((v) => (predicate(v) ? v : undefined), m);
}

export function choose2V<K, A, B, T>(
  mapping: (k: K, a: A | undefined, b: B | undefined) => T | undefined,
  a: amap<K, A>,
  b: amap<K, B>,
): amap<K, T> {
  if (a.isConstant && b.isConstant) {
    return ofHashMap(force(a).choose2V<B, T>(force(b), mapping));
  }
  return ofReaderInternal<K, T>(
    () => new Choose2VReader<K, A, B, T>(mapping, a, b),
  );
}

export function choose2<K, A, B, T>(
  mapping: (k: K, a: A | undefined, b: B | undefined) => T | undefined,
  a: amap<K, A>,
  b: amap<K, B>,
): amap<K, T> {
  return choose2V(mapping, a, b);
}

export function intersectWith<K, A, B, T>(
  mapping: (k: K, a: A, b: B) => T,
  a: amap<K, A>,
  b: amap<K, B>,
): amap<K, T> {
  return choose2V<K, A, B, T>(
    (k, av, bv) => {
      if (av !== undefined && bv !== undefined) return mapping(k, av, bv);
      return undefined;
    },
    a,
    b,
  );
}

export function intersect<K, A, B>(
  a: amap<K, A>,
  b: amap<K, B>,
): amap<K, [A, B]> {
  return intersectWith<K, A, B, [A, B]>(
    (_k, av, bv) => [av, bv] as [A, B],
    a,
    b,
  );
}

export function unionWith<K, V>(
  resolve: (k: K, l: V, r: V) => V,
  a: amap<K, V>,
  b: amap<K, V>,
): amap<K, V> {
  if (a.isConstant && b.isConstant) {
    return constant(() => force(a).unionWith(force(b), resolve));
  }
  return ofReaderInternal<K, V>(() => new UnionWithReader<K, V>(a, b, resolve));
}

export function union<K, V>(
  a: amap<K, V>,
  b: amap<K, V>,
): amap<K, V> {
  return unionWith<K, V>((_k, _l, r) => r, a, b);
}

export function bind<T, K, V>(
  mapping: (t: T) => amap<K, V>,
  value: aval<T>,
): amap<K, V> {
  if (value.isConstant) return mapping(AVal.force(value));
  return ofReaderInternal<K, V>(
    () => new BindReader<T, K, V>(value, mapping),
  );
}

export function bind2<A, B, K, V>(
  mapping: (a: A, b: B) => amap<K, V>,
  va: aval<A>,
  vb: aval<B>,
): amap<K, V> {
  // Bridge Zipped → aval<[A,B]> via Zipped.map.
  const zipped: aval<[A, B]> = AVal.zip(va, vb).map(
    (a: A, b: B) => [a, b] as [A, B],
  );
  return bind<[A, B], K, V>(([a, b]) => mapping(a, b), zipped);
}

export function bind3<A, B, C, K, V>(
  mapping: (a: A, b: B, c: C) => amap<K, V>,
  va: aval<A>,
  vb: aval<B>,
  vc: aval<C>,
): amap<K, V> {
  const zipped: aval<[A, B, C]> = AVal.zip(va, vb, vc).map(
    (a: A, b: B, c: C) => [a, b, c] as [A, B, C],
  );
  return bind<[A, B, C], K, V>(
    ([a, b, c]) => mapping(a, b, c),
    zipped,
  );
}

export function mapA<K, V1, V2>(
  mapping: (k: K, v: V1) => aval<V2>,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    const cur = force(m).map(mapping);
    if (cur.fold((acc, _k, v) => acc && v.isConstant, true)) {
      return constant(() => cur.map((_k, v) => AVal.force(v)));
    }
    return ofReaderInternal<K, V2>(
      () => new MapAReader<K, aval<V2>, V2>(ofHashMap(cur), (_k, v) => v),
    );
  }
  return ofReaderInternal<K, V2>(() => new MapAReader<K, V1, V2>(m, mapping));
}

export function chooseA<K, V1, V2>(
  mapping: (k: K, v: V1) => aval<V2 | undefined>,
  m: amap<K, V1>,
): amap<K, V2> {
  if (m.isConstant) {
    const cur = force(m).map(mapping);
    if (cur.fold((acc, _k, v) => acc && v.isConstant, true)) {
      return constant(() => cur.choose((_k, v) => AVal.force(v)));
    }
    return ofReaderInternal<K, V2>(
      () =>
        new ChooseAReader<K, aval<V2 | undefined>, V2>(
          ofHashMap(cur),
          (_k, v) => v,
        ),
    );
  }
  return ofReaderInternal<K, V2>(
    () => new ChooseAReader<K, V1, V2>(m, mapping),
  );
}

export function filterA<K, V>(
  predicate: (k: K, v: V) => aval<boolean>,
  m: amap<K, V>,
): amap<K, V> {
  return chooseA<K, V, V>(
    (k, v) =>
      AVal.map(predicate(k, v), (b: boolean) => (b ? v : undefined)),
    m,
  );
}

// ofASet variants ------------------------------------------------------------
//
// Like `toASet`, the ofASet variants take `aset<KeyValuePair<K, V>>`
// rather than `aset<[K, V]>` to keep structural equality on pairs.

export function ofASetIgnoreDuplicates<K, V>(
  elements: aset<KeyValuePair<K, V>>,
): amap<K, V> {
  if (elements.isConstant) {
    return constant(() => {
      let out = HashMap.empty<K, V>();
      for (const kv of AVal.force(elements.content))
        out = out.add(kv.key, kv.value);
      return out;
    });
  }
  return ofReaderInternal<K, V>(
    () => new SetReader<K, V, V>(elements, (s) => s.first()),
  );
}

export function ofASetMappedIgnoreDuplicates<K, V>(
  getKey: (v: V) => K,
  elements: aset<V>,
): amap<K, V> {
  if (elements.isConstant) {
    return constant(() => {
      let out = HashMap.empty<K, V>();
      for (const v of AVal.force(elements.content)) {
        out = out.add(getKey(v), v);
      }
      return out;
    });
  }
  return ofReaderInternal<K, V>(
    () => new MappedSetReader<K, V, V>(elements, getKey, (s) => s.first()),
  );
}

export function ofASet<K, V>(
  elements: aset<KeyValuePair<K, V>>,
): amap<K, HashSet<V>> {
  if (elements.isConstant) {
    return constant(() => {
      let out = HashMap.empty<K, HashSet<V>>();
      for (const kv of AVal.force(elements.content)) {
        out = out.alter(kv.key, (o) =>
          o === undefined ? HashSet.single(kv.value) : o.add(kv.value),
        );
      }
      return out;
    });
  }
  return ofReaderInternal<K, HashSet<V>>(
    () => new SetReader<K, V, HashSet<V>>(elements, (s) => s),
  );
}

export function ofASetMapped<K, V>(
  getKey: (v: V) => K,
  elements: aset<V>,
): amap<K, HashSet<V>> {
  if (elements.isConstant) {
    return constant(() => {
      let out = HashMap.empty<K, HashSet<V>>();
      for (const v of AVal.force(elements.content)) {
        const k = getKey(v);
        out = out.alter(k, (o) =>
          o === undefined ? HashSet.single(v) : o.add(v),
        );
      }
      return out;
    });
  }
  return ofReaderInternal<K, HashSet<V>>(
    () =>
      new MappedSetReader<K, V, HashSet<V>>(elements, getKey, (s) => s),
  );
}

// toASet ---------------------------------------------------------------------

export function toASet<K, V>(m: amap<K, V>): aset<KeyValuePair<K, V>> {
  if (m.isConstant) {
    return ASetOps.constant<KeyValuePair<K, V>>(() =>
      HashSet.ofSeq([...force(m)].map(([k, v]) => new KeyValuePair(k, v))),
    );
  }
  return ASetOps.ofReader<KeyValuePair<K, V>>(
    () => new ToASetReader<K, V>(m),
  );
}

export function toASetValues<K, V>(m: amap<K, V>): aset<V> {
  if (m.isConstant) {
    return ASetOps.constant<V>(() =>
      HashSet.ofSeq([...force(m)].map(([_k, v]) => v)),
    );
  }
  return ASetOps.ofReader<V>(() => new ToValueASetReader<K, V>(m));
}

// Lookup ---------------------------------------------------------------------

export function tryFind<K, V>(key: K, m: amap<K, V>): aval<V | undefined> {
  return AVal.map(m.content, (s) => s.tryFind(key));
}

export function find<K, V>(key: K, m: amap<K, V>): aval<V> {
  return AVal.map(m.content, (s: HashMap<K, V>) => {
    const v = s.tryFind(key);
    if (v === undefined && !s.containsKey(key)) {
      throw new Error(`could not get key: ${String(key)}`);
    }
    return v as V;
  });
}

// Reductions / aggregates ----------------------------------------------------

export function isEmpty<K, V>(m: amap<K, V>): aval<boolean> {
  return AVal.map(m.content, (s: HashMap<K, V>) => s.isEmpty);
}
export function count<K, V>(m: amap<K, V>): aval<number> {
  return AVal.map(m.content, (s: HashMap<K, V>) => s.count);
}

export function reduce<K, V, S, R>(
  reduction: AdaptiveReduction<V, S, R>,
  m: amap<K, V>,
): aval<R> {
  return AVal.map(m.content, (s: HashMap<K, V>) =>
    reduction.view(
      s.fold((acc, _k, v) => reduction.add(acc, v), reduction.seed),
    ),
  );
}

export function reduceBy<K, V1, V2, S, R>(
  reduction: AdaptiveReduction<V2, S, R>,
  mapping: (k: K, v: V1) => V2,
  m: amap<K, V1>,
): aval<R> {
  return AVal.map(m.content, (s: HashMap<K, V1>) =>
    reduction.view(
      s.fold(
        (acc, k, v) => reduction.add(acc, mapping(k, v)),
        reduction.seed,
      ),
    ),
  );
}

export function reduceByA<K, V1, V2, S, R>(
  reduction: AdaptiveReduction<V2, S, R>,
  mapping: (k: K, v: V1) => aval<V2>,
  m: amap<K, V1>,
): aval<R> {
  // Slow path: re-evaluate everything every time.
  return AVal.custom((tok) => {
    const s = m.content.getValue(tok);
    let acc = reduction.seed;
    for (const [k, v] of s) {
      const av = mapping(k, v).getValue(tok);
      acc = reduction.add(acc, av);
    }
    return reduction.view(acc);
  });
}

export function forall<K, V>(
  predicate: (k: K, v: V) => boolean,
  m: amap<K, V>,
): aval<boolean> {
  return reduceBy<K, V, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n === 0,
      Reductions.countNegative,
    ),
    predicate,
    m,
  );
}

export function exists<K, V>(
  predicate: (k: K, v: V) => boolean,
  m: amap<K, V>,
): aval<boolean> {
  return reduceBy<K, V, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n !== 0,
      Reductions.countPositive,
    ),
    predicate,
    m,
  );
}

export function forallA<K, V>(
  predicate: (k: K, v: V) => aval<boolean>,
  m: amap<K, V>,
): aval<boolean> {
  return reduceByA<K, V, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n === 0,
      Reductions.countNegative,
    ),
    predicate,
    m,
  );
}

export function existsA<K, V>(
  predicate: (k: K, v: V) => aval<boolean>,
  m: amap<K, V>,
): aval<boolean> {
  return reduceByA<K, V, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n !== 0,
      Reductions.countPositive,
    ),
    predicate,
    m,
  );
}

export function countBy<K, V>(
  predicate: (k: K, v: V) => boolean,
  m: amap<K, V>,
): aval<number> {
  return reduceBy(Reductions.countPositive, predicate, m);
}
export function countByA<K, V>(
  predicate: (k: K, v: V) => aval<boolean>,
  m: amap<K, V>,
): aval<number> {
  return reduceByA(Reductions.countPositive, predicate, m);
}

export function sumBy<K, V>(
  mapping: (k: K, v: V) => number,
  m: amap<K, V>,
): aval<number> {
  return reduceBy(Reductions.sum, mapping, m);
}
export function sumByA<K, V>(
  mapping: (k: K, v: V) => aval<number>,
  m: amap<K, V>,
): aval<number> {
  return reduceByA(Reductions.sum, mapping, m);
}
export function averageBy<K, V>(
  mapping: (k: K, v: V) => number,
  m: amap<K, V>,
): aval<number> {
  return reduceBy(Reductions.average, mapping, m);
}
export function averageByA<K, V>(
  mapping: (k: K, v: V) => aval<number>,
  m: amap<K, V>,
): aval<number> {
  return reduceByA(Reductions.average, mapping, m);
}

export function foldGroup<K, V, S>(
  add: (s: S, k: K, v: V) => S,
  sub: (s: S, k: K, v: V) => S,
  zero: S,
  m: amap<K, V>,
): aval<S> {
  return reduceBy<K, V, [K, V], S, S>(
    Reductions.group(zero, (s, [k, v]) => add(s, k, v), (s, [k, v]) => sub(s, k, v)),
    (k, v) => [k, v] as [K, V],
    m,
  );
}

export function foldHalfGroup<K, V, S>(
  add: (s: S, k: K, v: V) => S,
  trySub: (s: S, k: K, v: V) => S | undefined,
  zero: S,
  m: amap<K, V>,
): aval<S> {
  return reduceBy<K, V, [K, V], S, S>(
    Reductions.halfGroup(
      zero,
      (s, [k, v]) => add(s, k, v),
      (s, [k, v]) => trySub(s, k, v),
    ),
    (k, v) => [k, v] as [K, V],
    m,
  );
}

export function fold<K, V, S>(
  add: (s: S, k: K, v: V) => S,
  zero: S,
  m: amap<K, V>,
): aval<S> {
  return reduceBy<K, V, [K, V], S, S>(
    Reductions.fold(zero, (s, [k, v]) => add(s, k, v)),
    (k, v) => [k, v] as [K, V],
    m,
  );
}

// ---------------------------------------------------------------------------
// AMap namespace export
// ---------------------------------------------------------------------------

export const AMap = {
  empty,
  single,
  ofSeq,
  ofList,
  ofArray,
  ofHashMap,
  ofAVal,
  ofASet,
  ofASetMapped,
  ofASetIgnoreDuplicates,
  ofASetMappedIgnoreDuplicates,
  ofReader,
  custom,
  toAVal,
  map,
  mapValue,
  mapSet,
  choose,
  chooseValue,
  filter,
  filterValue,
  choose2V,
  choose2,
  intersectWith,
  intersect,
  unionWith,
  union,
  bind,
  bind2,
  bind3,
  mapA,
  chooseA,
  filterA,
  toASet,
  toASetValues,
  tryFind,
  find,
  isEmpty,
  count,
  reduce,
  reduceBy,
  reduceByA,
  forall,
  exists,
  forallA,
  existsA,
  countBy,
  countByA,
  sumBy,
  sumByA,
  averageBy,
  averageByA,
  foldGroup,
  foldHalfGroup,
  fold,
  force,
};
