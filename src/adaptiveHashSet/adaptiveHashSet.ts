// Port of FSharp.Data.Adaptive AdaptiveHashSet/AdaptiveHashSet.fs
//
// PORT NOTE: F# uses a few internal extension members on aset (e.g.
// `set.IsConstant`, `set.History`, `set.GetReader()`) plus inheritance
// patterns (the `aset<'T>` interface implemented by EmptySet /
// ConstantSet / AdaptiveHashSetImpl / readers themselves). This port
// preserves that shape: an `aset<T>` interface, plus readers in classes
// that extend AbstractReader / AbstractDirtyReader from
// `traceable/history.ts`.
//
// PORT NOTE: F# `Cache<'A,'B>` (refcounted memoization) ports to our
// `utilities/cache.ts`. The per-reader caches use it for the same
// invoke-on-add / revoke-on-remove pattern.
//
// PORT NOTE: `HashSetDelta.collect` / `HashSetDelta.choose` etc. are
// already in our port.

import {
  AVal,
  constant as avalConstant,
  delay as avalDelay,
  type aval,
} from "../adaptiveValue/adaptiveValue.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import type { IAdaptiveObject } from "../core/types.js";
import {
  HashMap,
  HashSet,
} from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { SetOperation } from "../datastructures/operations.js";
import { Cache } from "../utilities/cache.js";
import { MultiSetMap } from "../datastructures/multiSetMap.js";
import { AbstractVal } from "../adaptiveValue/adaptiveValue.js";
import {
  CountingHashSet,
  hashSetDeltaMonoid,
} from "../traceable/countingHashSet.js";
import {
  AbstractDirtyReader,
  AbstractReader,
  ConstantReader,
  EmptyReader,
  History,
  type IOpReaderWithState,
} from "../traceable/history.js";
import type { Traceable } from "../traceable/traceable.js";
import type { AdaptiveReduction } from "../adaptiveValue/adaptiveReduction.js";
import * as Reductions from "../adaptiveValue/adaptiveReduction.js";

/**
 * An adaptive reader for `aset` that allows pulling operations and
 * exposes its current state.
 */
export type IHashSetReader<T> = IOpReaderWithState<
  CountingHashSet<T>,
  HashSetDelta<T>
>;

/** Adaptive set datastructure. */
export interface aset<T> {
  /** Is the set constant? */
  readonly isConstant: boolean;
  /** The current content of the set as aval. */
  readonly content: aval<HashSet<T>>;
  /** Gets a new reader to the set. */
  getReader(): IHashSetReader<T>;
  /** The underlying History instance for the aset (if any). */
  readonly history: History<CountingHashSet<T>, HashSetDelta<T>> | undefined;

  // transforms
  map<R>(mapping: (t: T) => R): aset<R>;
  choose<R>(mapping: (t: T) => R | undefined): aset<R>;
  filter(predicate: (t: T) => boolean): aset<T>;
  collect<R>(mapping: (t: T) => aset<R>): aset<R>;
  collectSeq<R>(mapping: (t: T) => Iterable<R>): aset<R>;
  union(other: aset<T>): aset<T>;
  difference(other: aset<T>): aset<T>;
  intersect(other: aset<T>): aset<T>;
  xor(other: aset<T>): aset<T>;
  mapA<R>(mapping: (t: T) => aval<R>): aset<R>;
  chooseA<R>(mapping: (t: T) => aval<R | undefined>): aset<R>;
  filterA(predicate: (t: T) => aval<boolean>): aset<T>;
  // queries returning aval
  isEmpty(): aval<boolean>;
  count(): aval<number>;
  contains(value: T): aval<boolean>;
  forall(predicate: (t: T) => boolean): aval<boolean>;
  exists(predicate: (t: T) => boolean): aval<boolean>;
  forallA(predicate: (t: T) => aval<boolean>): aval<boolean>;
  existsA(predicate: (t: T) => aval<boolean>): aval<boolean>;
  countBy(predicate: (t: T) => boolean): aval<number>;
  countByA(predicate: (t: T) => aval<boolean>): aval<number>;
  sumBy(mapping: (t: T) => number): aval<number>;
  sumByA(mapping: (t: T) => aval<number>): aval<number>;
  averageBy(mapping: (t: T) => number): aval<number>;
  averageByA(mapping: (t: T) => aval<number>): aval<number>;
  reduce<S, V>(reduction: AdaptiveReduction<T, S, V>): aval<V>;
  reduceBy<T2, S, V>(reduction: AdaptiveReduction<T2, S, V>, mapping: (t: T) => T2): aval<V>;
  reduceByA<B, S, V>(reduction: AdaptiveReduction<B, S, V>, mapping: (t: T) => aval<B>): aval<V>;
  fold<S>(add: (s: S, v: T) => S, zero: S): aval<S>;
  foldGroup<S>(add: (s: S, v: T) => S, subtract: (s: S, v: T) => S, zero: S): aval<S>;
  foldHalfGroup<S>(add: (s: S, v: T) => S, trySubtract: (s: S, v: T) => S | undefined, zero: S): aval<S>;
  tryMin(compare?: (a: T, b: T) => number): aval<T | undefined>;
  tryMax(compare?: (a: T, b: T) => number): aval<T | undefined>;
  toAVal(): aval<HashSet<T>>;
  force(): HashSet<T>;
}

/** Convenience: pull the current content of an aset (untracked). */
export function force<T>(set: aset<T>): HashSet<T> {
  return AVal.force(set.content);
}

export abstract class AbstractAset<T> implements aset<T> {
  abstract readonly isConstant: boolean;
  abstract readonly content: aval<HashSet<T>>;
  abstract readonly history: History<CountingHashSet<T>, HashSetDelta<T>> | undefined;
  abstract getReader(): IHashSetReader<T>;

  map<R>(mapping: (t: T) => R): aset<R> { return map(mapping, this); }
  choose<R>(mapping: (t: T) => R | undefined): aset<R> { return choose(mapping, this); }
  filter(predicate: (t: T) => boolean): aset<T> { return filter(predicate, this); }
  collect<R>(mapping: (t: T) => aset<R>): aset<R> { return collect(mapping, this); }
  collectSeq<R>(mapping: (t: T) => Iterable<R>): aset<R> { return collectSeq(mapping, this); }
  union(other: aset<T>): aset<T> { return union(this, other); }
  difference(other: aset<T>): aset<T> { return difference(this, other); }
  intersect(other: aset<T>): aset<T> { return intersect(this, other); }
  xor(other: aset<T>): aset<T> { return xor(this, other); }
  mapA<R>(mapping: (t: T) => aval<R>): aset<R> { return mapA(mapping, this); }
  chooseA<R>(mapping: (t: T) => aval<R | undefined>): aset<R> { return chooseA(mapping, this); }
  filterA(predicate: (t: T) => aval<boolean>): aset<T> { return filterA(predicate, this); }
  isEmpty(): aval<boolean> { return isEmpty(this); }
  count(): aval<number> { return count(this); }
  contains(value: T): aval<boolean> { return contains(value, this); }
  forall(predicate: (t: T) => boolean): aval<boolean> { return forall(predicate, this); }
  exists(predicate: (t: T) => boolean): aval<boolean> { return exists(predicate, this); }
  forallA(predicate: (t: T) => aval<boolean>): aval<boolean> { return forallA(predicate, this); }
  existsA(predicate: (t: T) => aval<boolean>): aval<boolean> { return existsA(predicate, this); }
  countBy(predicate: (t: T) => boolean): aval<number> { return countBy(predicate, this); }
  countByA(predicate: (t: T) => aval<boolean>): aval<number> { return countByA(predicate, this); }
  sumBy(mapping: (t: T) => number): aval<number> { return sumBy(mapping, this); }
  sumByA(mapping: (t: T) => aval<number>): aval<number> { return sumByA(mapping, this); }
  averageBy(mapping: (t: T) => number): aval<number> { return averageBy(mapping, this); }
  averageByA(mapping: (t: T) => aval<number>): aval<number> { return averageByA(mapping, this); }
  reduce<S, V>(reduction: AdaptiveReduction<T, S, V>): aval<V> { return reduce(reduction, this); }
  reduceBy<T2, S, V>(reduction: AdaptiveReduction<T2, S, V>, mapping: (t: T) => T2): aval<V> { return reduceBy(reduction, mapping, this); }
  reduceByA<B, S, V>(reduction: AdaptiveReduction<B, S, V>, mapping: (t: T) => aval<B>): aval<V> { return reduceByA(reduction, mapping, this); }
  fold<S>(add: (s: S, v: T) => S, zero: S): aval<S> { return fold(add, zero, this); }
  foldGroup<S>(add: (s: S, v: T) => S, subtract: (s: S, v: T) => S, zero: S): aval<S> { return foldGroup(add, subtract, zero, this); }
  foldHalfGroup<S>(add: (s: S, v: T) => S, trySubtract: (s: S, v: T) => S | undefined, zero: S): aval<S> { return foldHalfGroup(add, trySubtract, zero, this); }
  tryMin(compare?: (a: T, b: T) => number): aval<T | undefined> { return tryMin(this, compare); }
  tryMax(compare?: (a: T, b: T) => number): aval<T | undefined> { return tryMax(this, compare); }
  toAVal(): aval<HashSet<T>> { return toAVal(this); }
  force(): HashSet<T> { return force(this); }
}

// ---------------------------------------------------------------------------
// Empty / Constant / impl wrappers
// ---------------------------------------------------------------------------

class EmptyAset<T> extends AbstractAset<T> {
  override readonly isConstant = true;
  override readonly content: aval<HashSet<T>> = avalConstant(HashSet.empty<T>());
  override readonly history = undefined;
  private static _instances = new WeakMap<object, EmptyAset<unknown>>();
  static instance<T>(): aset<T> {
    // single per-runtime instance; type tag doesn't matter at runtime
    if (!EmptyAset._cached) EmptyAset._cached = new EmptyAset<unknown>();
    return EmptyAset._cached as aset<T>;
  }
  private static _cached: EmptyAset<unknown> | null = null;
  override getReader(): IHashSetReader<T> {
    return new EmptyReader<CountingHashSet<T>, HashSetDelta<T>>(
      CountingHashSet.trace<T>(),
    );
  }
}

class ConstantAset<T> extends AbstractAset<T> {
  override readonly isConstant = true;
  private readonly _create: () => HashSet<T>;
  private _cachedSet: HashSet<T> | null = null;
  override readonly content: aval<HashSet<T>>;
  override readonly history = undefined;

  constructor(create: () => HashSet<T>) {
    super();
    this._create = create;
    this.content = avalDelay(() => this.lazySet());
  }

  private lazySet(): HashSet<T> {
    if (this._cachedSet === null) this._cachedSet = this._create();
    return this._cachedSet;
  }

  override getReader(): IHashSetReader<T> {
    return new ConstantReader<CountingHashSet<T>, HashSetDelta<T>>(
      CountingHashSet.trace<T>(),
      () => HashSet.ofArray(this.lazySet().toArray()).fold((d, k) => d.add(SetOperation.add(k)), HashSetDelta.empty<T>()),
      () => CountingHashSet.ofHashSet(this.lazySet()),
    );
  }
}

class AdaptiveHashSetImpl<T> extends AbstractAset<T> {
  override readonly isConstant = false;
  override readonly history: History<CountingHashSet<T>, HashSetDelta<T>>;
  override readonly content: aval<HashSet<T>>;

  constructor(createReader: () => IOpReaderWithState<unknown, HashSetDelta<T>>) {
    super();
    this.history = History.ofReader<CountingHashSet<T>, HashSetDelta<T>>(
      CountingHashSet.trace<T>(),
      () => createReader() as unknown as IOpReaderWithState<CountingHashSet<T>, HashSetDelta<T>>,
    );
    this.content = AVal.custom((tok) => {
      this.history.getValue(tok).toHashSet();
      return this.history.state.toHashSet();
    });
  }

  override getReader(): IHashSetReader<T> {
    return this.history.newReader();
  }
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

class MapReader<A, B> extends AbstractReader<HashSetDelta<B>> {
  private readonly _cache: Cache<A, B>;
  private readonly _reader: IHashSetReader<A>;
  constructor(input: aset<A>, mapping: (a: A) => B) {
    super(HashSetDelta.empty<B>());
    this._cache = new Cache<A, B>(mapping);
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<B> {
    return this._reader.getChanges(tok).map((d) => {
      if (d.count === 1) return SetOperation.add(this._cache.invoke(d.value));
      if (d.count === -1) return SetOperation.rem(this._cache.revokeUnsafe(d.value));
      throw new Error("[ASet] unexpected delta count");
    });
  }
}

class ChooseReader<A, B> extends AbstractReader<HashSetDelta<B>> {
  private readonly _cache: Cache<A, B | undefined>;
  private readonly _reader: IHashSetReader<A>;
  constructor(input: aset<A>, mapping: (a: A) => B | undefined) {
    super(HashSetDelta.empty<B>());
    this._cache = new Cache<A, B | undefined>(mapping);
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<B> {
    return this._reader.getChanges(tok).choose((d) => {
      if (d.count === 1) {
        const v = this._cache.invoke(d.value);
        return v === undefined ? undefined : SetOperation.add(v);
      }
      if (d.count === -1) {
        const v = this._cache.tryRevoke(d.value);
        return v === undefined ? undefined : SetOperation.rem(v);
      }
      throw new Error("[ASet] unexpected delta count");
    });
  }
}

class FilterReader<T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _cache: Cache<T, boolean>;
  private readonly _reader: IHashSetReader<T>;
  constructor(input: aset<T>, predicate: (t: T) => boolean) {
    super(HashSetDelta.empty<T>());
    this._cache = new Cache<T, boolean>(predicate);
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    return this._reader.getChanges(tok).filter((d) => {
      if (d.count === 1) return this._cache.invoke(d.value);
      if (d.count === -1) return this._cache.revokeUnsafe(d.value);
      throw new Error("[ASet] unexpected delta count");
    });
  }
}

const INNER_TAG = "InnerReader";

class CollectReader<A, B>
  extends AbstractDirtyReader<IHashSetReader<B>, HashSetDelta<B>>
{
  private readonly _reader: IHashSetReader<A>;
  private readonly _cache: Cache<A, IHashSetReader<B>>;
  constructor(input: aset<A>, mapping: (a: A) => aset<B>) {
    super(hashSetDeltaMonoid<B>(), (tag) => tag === INNER_TAG);
    this._reader = input.getReader();
    this._cache = new Cache<A, IHashSetReader<B>>((value) => {
      const r = mapping(value).getReader();
      r.tag = INNER_TAG;
      return r;
    });
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<IHashSetReader<B>>,
  ): HashSetDelta<B> {
    let deltas = this._reader.getChanges(tok).collect((d) => {
      if (d.count === 1) {
        const r = this._cache.invoke(d.value);
        dirty.delete(r);
        return r.getChanges(tok);
      }
      if (d.count === -1) {
        const r = this._cache.tryRevokeAndGetDeleted(d.value);
        if (r === undefined) return HashSetDelta.empty<B>();
        dirty.delete(r.value);
        if (r.deleted) {
          r.value.outputs.remove(this);
          return r.value.state.removeAll();
        }
        return r.value.getChanges(tok);
      }
      throw new Error("[ASet] unexpected delta count");
    });
    for (const d of dirty) {
      deltas = deltas.combine(d.getChanges(tok));
    }
    return deltas;
  }
}

class CollectSeqReader<A, B> extends AbstractReader<HashSetDelta<B>> {
  private readonly _cache: Cache<A, HashSet<B>>;
  private readonly _reader: IHashSetReader<A>;
  constructor(input: aset<A>, mapping: (a: A) => Iterable<B>) {
    super(HashSetDelta.empty<B>());
    this._cache = new Cache<A, HashSet<B>>((v) => HashSet.ofSeq(mapping(v)));
    this._reader = input.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<B> {
    return this._reader.getChanges(tok).collect((d) => {
      if (d.count === 1) {
        const fresh = this._cache.invoke(d.value);
        let out = HashSetDelta.empty<B>();
        for (const k of fresh) out = out.add(SetOperation.add(k));
        return out;
      }
      if (d.count === -1) {
        const stale = this._cache.revokeUnsafe(d.value);
        let out = HashSetDelta.empty<B>();
        for (const k of stale) out = out.add(SetOperation.rem(k));
        return out;
      }
      throw new Error("[ASet] unexpected delta count");
    });
  }
}

class UnionReader<T>
  extends AbstractDirtyReader<IHashSetReader<T>, HashSetDelta<T>>
{
  private readonly _reader: IHashSetReader<aset<T>>;
  private readonly _cache: Cache<aset<T>, IHashSetReader<T>>;
  constructor(input: aset<aset<T>>) {
    super(hashSetDeltaMonoid<T>(), (tag) => tag === INNER_TAG);
    this._reader = input.getReader();
    this._cache = new Cache<aset<T>, IHashSetReader<T>>((inner) => {
      const r = inner.getReader();
      r.tag = INNER_TAG;
      return r;
    });
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<IHashSetReader<T>>,
  ): HashSetDelta<T> {
    let deltas = this._reader.getChanges(tok).collect((d) => {
      if (d.count === 1) {
        const r = this._cache.invoke(d.value);
        dirty.delete(r);
        return r.getChanges(tok);
      }
      if (d.count === -1) {
        const r = this._cache.tryRevokeAndGetDeleted(d.value);
        if (r === undefined) return HashSetDelta.empty<T>();
        dirty.delete(r.value);
        if (r.deleted) {
          r.value.outputs.remove(this);
          return r.value.state.removeAll();
        }
        return r.value.getChanges(tok);
      }
      throw new Error("[ASet] unexpected delta count");
    });
    for (const d of dirty) deltas = deltas.combine(d.getChanges(tok));
    return deltas;
  }
}

class DifferenceReader<T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _r1: IHashSetReader<T>;
  private readonly _r2: IHashSetReader<T>;
  // state[k] = (refCount in left, refCount in right)
  private _state: HashMap<T, [number, number]> = HashMap.empty<T, [number, number]>();
  constructor(set1: aset<T>, set2: aset<T>) {
    super(HashSetDelta.empty<T>());
    this._r1 = set1.getReader();
    this._r2 = set2.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    const ch1 = this._r1.getChanges(tok).toMap();
    const ch2 = this._r2.getChanges(tok).toMap();
    const merged = ch1.choose2V<number, [number | undefined, number | undefined]>(
      ch2,
      (_k, l, r) => [l, r],
    );
    const apply = (
      _k: T,
      existing: [number, number] | undefined,
      d: [number | undefined, number | undefined],
    ): [[number, number] | undefined, number | undefined] => {
      const [or1, or2] = existing ?? [0, 0];
      const nr1 = d[0] !== undefined ? or1 + d[0] : or1;
      const nr2 = d[1] !== undefined ? or2 + d[1] : or2;
      const oldRef = or1 - or2;
      const newRef = nr1 - nr2;
      let dlt: number | undefined = undefined;
      if (newRef > 0 && oldRef <= 0) dlt = 1;
      else if (newRef <= 0 && oldRef > 0) dlt = -1;
      const out: [number, number] | undefined =
        nr1 > 0 || nr2 > 0 ? [nr1, nr2] : undefined;
      return [out, dlt];
    };
    const r = HashMap.applyDeltaV<
      T,
      [number, number],
      [number | undefined, number | undefined],
      number
    >(this._state, merged, apply);
    this._state = r.state;
    return HashSetDelta.ofHashMap(r.effective);
  }
}

class IntersectReader<T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _r1: IHashSetReader<T>;
  private readonly _r2: IHashSetReader<T>;
  private _state: HashMap<T, [number, number]> = HashMap.empty<T, [number, number]>();
  constructor(set1: aset<T>, set2: aset<T>) {
    super(HashSetDelta.empty<T>());
    this._r1 = set1.getReader();
    this._r2 = set2.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    const ch1 = this._r1.getChanges(tok).toMap();
    const ch2 = this._r2.getChanges(tok).toMap();
    const merged = ch1.choose2V<number, [number | undefined, number | undefined]>(
      ch2,
      (_k, l, r) => [l, r],
    );
    const apply = (
      _k: T,
      existing: [number, number] | undefined,
      d: [number | undefined, number | undefined],
    ): [[number, number] | undefined, number | undefined] => {
      const [or1, or2] = existing ?? [0, 0];
      const nr1 = d[0] !== undefined ? or1 + d[0] : or1;
      const nr2 = d[1] !== undefined ? or2 + d[1] : or2;
      const oldRef = Math.min(or1, or2);
      const newRef = Math.min(nr1, nr2);
      let dlt: number | undefined = undefined;
      if (newRef > 0 && oldRef <= 0) dlt = 1;
      else if (newRef <= 0 && oldRef > 0) dlt = -1;
      const out: [number, number] | undefined =
        nr1 > 0 || nr2 > 0 ? [nr1, nr2] : undefined;
      return [out, dlt];
    };
    const r = HashMap.applyDeltaV<
      T,
      [number, number],
      [number | undefined, number | undefined],
      number
    >(this._state, merged, apply);
    this._state = r.state;
    return HashSetDelta.ofHashMap(r.effective);
  }
}

class XorReader<T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _r1: IHashSetReader<T>;
  private readonly _r2: IHashSetReader<T>;
  private _state: HashMap<T, [number, number]> = HashMap.empty<T, [number, number]>();
  constructor(set1: aset<T>, set2: aset<T>) {
    super(HashSetDelta.empty<T>());
    this._r1 = set1.getReader();
    this._r2 = set2.getReader();
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    const ch1 = this._r1.getChanges(tok).toMap();
    const ch2 = this._r2.getChanges(tok).toMap();
    const merged = ch1.choose2V<number, [number | undefined, number | undefined]>(
      ch2,
      (_k, l, r) => [l, r],
    );
    const apply = (
      _k: T,
      existing: [number, number] | undefined,
      d: [number | undefined, number | undefined],
    ): [[number, number] | undefined, number | undefined] => {
      const [or1, or2] = existing ?? [0, 0];
      const nr1 = d[0] !== undefined ? or1 + d[0] : or1;
      const nr2 = d[1] !== undefined ? or2 + d[1] : or2;
      const oldRef = (or1 + or2) % 2;
      const newRef = (nr1 + nr2) % 2;
      let dlt: number | undefined = undefined;
      if (newRef > 0 && oldRef <= 0) dlt = 1;
      else if (newRef <= 0 && oldRef > 0) dlt = -1;
      const out: [number, number] | undefined =
        nr1 > 0 || nr2 > 0 ? [nr1, nr2] : undefined;
      return [out, dlt];
    };
    const r = HashMap.applyDeltaV<
      T,
      [number, number],
      [number | undefined, number | undefined],
      number
    >(this._state, merged, apply);
    this._state = r.state;
    return HashSetDelta.ofHashMap(r.effective);
  }
}

class AValReader<S extends Iterable<T>, T> extends AbstractReader<HashSetDelta<T>> {
  private readonly _input: aval<S>;
  private _oldSet: HashSet<T> = HashSet.empty<T>();
  constructor(input: aval<S>) {
    super(HashSetDelta.empty<T>());
    this._input = input;
  }
  override compute(tok: AdaptiveToken): HashSetDelta<T> {
    const newSet = HashSet.ofSeq(this._input.getValue(tok));
    const deltas = this._oldSet.computeDeltaAsHashMapStd(newSet);
    this._oldSet = newSet;
    return HashSetDelta.ofHashMap(deltas);
  }
}

class BindReader<A, B> extends AbstractReader<HashSetDelta<B>> {
  private readonly _input: aval<A>;
  private readonly _mapping: (a: A) => aset<B>;
  private _valChanged = 0;
  private _cache: { value: A; reader: IHashSetReader<B> } | null = null;
  constructor(input: aval<A>, mapping: (a: A) => aset<B>) {
    super(HashSetDelta.empty<B>());
    this._input = input;
    this._mapping = mapping;
  }
  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    if (o.outputs === (this._input as unknown as IAdaptiveObject).outputs) {
      this._valChanged = 1;
    }
  }
  override compute(tok: AdaptiveToken): HashSetDelta<B> {
    const newValue = this._input.getValue(tok);
    const valChanged = this._valChanged !== 0;
    this._valChanged = 0;
    if (this._cache !== null) {
      if (valChanged && !Object.is(this._cache.value, newValue)) {
        const rem = this._cache.reader.state.removeAll();
        this._cache.reader.outputs.remove(this);
        const newReader = this._mapping(newValue).getReader();
        const add = newReader.getChanges(tok);
        this._cache = { value: newValue, reader: newReader };
        return rem.combine(add);
      }
      return this._cache.reader.getChanges(tok);
    }
    const r = this._mapping(newValue).getReader();
    this._cache = { value: newValue, reader: r };
    return r.getChanges(tok);
  }
}

const INNER_AVAL_TAG = "Reader";

class FlattenAReader<T>
  extends AbstractDirtyReader<aval<T>, HashSetDelta<T>>
{
  private readonly _reader: IHashSetReader<aval<T>>;
  private readonly _cache: Map<aval<T>, T> = new Map();
  constructor(input: aset<aval<T>>) {
    super(hashSetDeltaMonoid<T>(), (tag) => tag !== "Input");
    this._reader = input.getReader();
    this._reader.tag = "Input";
  }
  private invokeM(token: AdaptiveToken, m: aval<T>): T {
    const v = m.getValue(token);
    this._cache.set(m, v);
    return v;
  }
  private revokeM(m: aval<T>, dirty: Set<aval<T>>): T {
    const v = this._cache.get(m);
    if (v === undefined && !this._cache.has(m)) {
      throw new Error("[ASet] cannot remove unknown object");
    }
    this._cache.delete(m);
    (m as unknown as IAdaptiveObject).outputs.remove(this);
    dirty.delete(m);
    return v as T;
  }
  override compute(tok: AdaptiveToken, dirty: Set<aval<T>>): HashSetDelta<T> {
    let deltas = this._reader.getChanges(tok).map((d) => {
      const m = d.value;
      if (d.count === 1) return SetOperation.add(this.invokeM(tok, m));
      if (d.count === -1) return SetOperation.rem(this.revokeM(m, dirty));
      throw new Error("[ASet] unexpected delta count");
    });
    for (const d of dirty) {
      const o = this._cache.get(d);
      if (o === undefined && !this._cache.has(d)) continue;
      const n = d.getValue(tok);
      this._cache.set(d, n);
      if (!Object.is(o, n)) {
        deltas = deltas.combine(
          HashSetDelta.ofArray([SetOperation.add(n), SetOperation.rem(o as T)]),
        );
      }
    }
    return deltas;
  }
}

class MapAReader<A, B>
  extends AbstractDirtyReader<aval<B>, HashSetDelta<B>>
{
  private readonly _reader: IHashSetReader<A>;
  private readonly _mapping: Cache<A, aval<B>>;
  // For each inner aval, [refcount, last value]
  private readonly _cache: Map<aval<B>, { count: number; value: B }> = new Map();
  constructor(input: aset<A>, mapping: (a: A) => aval<B>) {
    super(hashSetDeltaMonoid<B>(), (tag) => tag !== INNER_AVAL_TAG);
    this._reader = input.getReader();
    this._reader.tag = INNER_AVAL_TAG;
    this._mapping = new Cache<A, aval<B>>(mapping);
  }
  private invokeM(token: AdaptiveToken, v: A): B {
    const m = this._mapping.invoke(v);
    const val = m.getValue(token);
    const e = this._cache.get(m);
    if (e !== undefined) e.count += 1;
    else this._cache.set(m, { count: 1, value: val });
    return val;
  }
  private revokeM(v: A, dirty: Set<aval<B>>): B {
    const m = this._mapping.tryRevoke(v);
    if (m === undefined) throw new Error("[ASet] cannot remove unknown object");
    const e = this._cache.get(m);
    if (e === undefined) throw new Error("[ASet] cannot remove unknown object");
    if (e.count === 1) {
      this._cache.delete(m);
      dirty.delete(m);
      (m as unknown as IAdaptiveObject).outputs.remove(this);
      return e.value;
    }
    e.count -= 1;
    return e.value;
  }
  override compute(tok: AdaptiveToken, dirty: Set<aval<B>>): HashSetDelta<B> {
    let deltas = this._reader.getChanges(tok).map((d) => {
      const m = d.value;
      if (d.count === 1) return SetOperation.add(this.invokeM(tok, m));
      if (d.count === -1) return SetOperation.rem(this.revokeM(m, dirty));
      throw new Error("[ASet] unexpected delta count");
    });
    for (const d of dirty) {
      const e = this._cache.get(d);
      if (e === undefined) continue;
      const n = d.getValue(tok);
      const old = e.value;
      e.value = n;
      if (!Object.is(old, n)) {
        deltas = deltas.combine(
          HashSetDelta.ofArray([SetOperation.add(n), SetOperation.rem(old)]),
        );
      }
    }
    return deltas;
  }
}

class ChooseAReader<A, B>
  extends AbstractDirtyReader<aval<B | undefined>, HashSetDelta<B>>
{
  private readonly _reader: IHashSetReader<A>;
  private readonly _f: Cache<A, aval<B | undefined>>;
  private readonly _cache: Map<
    aval<B | undefined>,
    { count: number; value: B | undefined }
  > = new Map();
  constructor(input: aset<A>, f: (a: A) => aval<B | undefined>) {
    super(hashSetDeltaMonoid<B>(), (tag) => tag !== INNER_AVAL_TAG);
    this._reader = input.getReader();
    this._reader.tag = INNER_AVAL_TAG;
    this._f = new Cache<A, aval<B | undefined>>(f);
  }
  private invokeM(token: AdaptiveToken, v: A): B | undefined {
    const m = this._f.invoke(v);
    const val = m.getValue(token);
    const e = this._cache.get(m);
    if (e !== undefined) e.count += 1;
    else this._cache.set(m, { count: 1, value: val });
    return val;
  }
  private invoke2(
    token: AdaptiveToken,
    m: aval<B | undefined>,
  ): { old: B | undefined; nu: B | undefined } {
    const e = this._cache.get(m);
    if (e === undefined) return { old: undefined, nu: undefined };
    const v = m.getValue(token);
    const old = e.value;
    e.value = v;
    return { old, nu: v };
  }
  private revokeM(v: A): B | undefined {
    const m = this._f.revokeUnsafe(v);
    const e = this._cache.get(m);
    if (e === undefined) throw new Error("[ASet] cannot remove unknown object");
    if (e.count === 1) {
      this._cache.delete(m);
      (m as unknown as IAdaptiveObject).outputs.remove(this);
    } else {
      e.count -= 1;
    }
    return e.value;
  }
  override compute(
    tok: AdaptiveToken,
    dirty: Set<aval<B | undefined>>,
  ): HashSetDelta<B> {
    let deltas = this._reader.getChanges(tok).choose((d) => {
      const m = d.value;
      if (d.count === 1) {
        const v = this.invokeM(tok, m);
        return v === undefined ? undefined : SetOperation.add(v);
      }
      if (d.count === -1) {
        const v = this.revokeM(m);
        return v === undefined ? undefined : SetOperation.rem(v);
      }
      throw new Error("[ASet] unexpected delta count");
    });
    for (const d of dirty) {
      const r = this.invoke2(tok, d);
      if (r.old === undefined && r.nu !== undefined) {
        deltas = deltas.add(SetOperation.add(r.nu));
      } else if (r.old !== undefined && r.nu === undefined) {
        deltas = deltas.add(SetOperation.rem(r.old));
      } else if (
        r.old !== undefined &&
        r.nu !== undefined &&
        !Object.is(r.old, r.nu)
      ) {
        deltas = deltas.add(SetOperation.rem(r.old)).add(SetOperation.add(r.nu));
      }
    }
    return deltas;
  }
}

// ---------------------------------------------------------------------------
// Public ASet module
// ---------------------------------------------------------------------------

function ofReaderInternal<T>(
  create: () => IOpReaderWithState<unknown, HashSetDelta<T>>,
): aset<T> {
  return new AdaptiveHashSetImpl<T>(create);
}

/** The empty aset. */
export function empty<T>(): aset<T> {
  return EmptyAset.instance<T>();
}

/** Creates a constant aset using the given lazy creator. */
export function constant<T>(value: () => HashSet<T>): aset<T> {
  return new ConstantAset<T>(value);
}

/** A constant aset holding a single value. */
export function single<T>(value: T): aset<T> {
  return constant(() => HashSet.single(value));
}

export function ofSeq<T>(elements: Iterable<T>): aset<T> {
  return constant(() => HashSet.ofSeq(elements));
}
export function ofList<T>(elements: T[]): aset<T> {
  return constant(() => HashSet.ofList(elements));
}
export function ofArray<T>(elements: T[]): aset<T> {
  return constant(() => HashSet.ofArray(elements));
}
export function ofHashSet<T>(elements: HashSet<T>): aset<T> {
  return constant(() => elements);
}

/** Creates an aval providing access to the current content of the set. */
export function toAVal<T>(set: aset<T>): aval<HashSet<T>> {
  return set.content;
}

/** Creates an aset using the given reader-creator. */
export function ofReader<T>(
  create: () => AbstractReader<HashSetDelta<T>>,
): aset<T> {
  return ofReaderInternal<T>(
    () => create() as unknown as IOpReaderWithState<unknown, HashSetDelta<T>>,
  );
}

/** Creates an aset from a custom compute function. */
export function custom<T>(
  compute: (tok: AdaptiveToken, state: CountingHashSet<T>) => HashSetDelta<T>,
): aset<T> {
  return ofReaderInternal<T>(() => {
    class Custom extends AbstractReader<HashSetDelta<T>>
      implements IOpReaderWithState<CountingHashSet<T>, HashSetDelta<T>>
    {
      readonly trace: Traceable<CountingHashSet<T>, HashSetDelta<T>> =
        CountingHashSet.trace<T>();
      private _state: CountingHashSet<T> = CountingHashSet.empty<T>();
      constructor() {
        super(HashSetDelta.empty<T>());
      }
      get state(): CountingHashSet<T> {
        return this._state;
      }
      override compute(tok: AdaptiveToken): HashSetDelta<T> {
        return compute(tok, this._state);
      }
      override applyOp(op: HashSetDelta<T>): HashSetDelta<T> {
        const r = this._state.applyDelta(op);
        this._state = r.state;
        return r.effective;
      }
    }
    return new Custom() as unknown as IOpReaderWithState<unknown, HashSetDelta<T>>;
  });
}

export function map<A, B>(mapping: (a: A) => B, set: aset<A>): aset<B> {
  if (set.isConstant) return constant(() => force(set).map(mapping));
  return ofReaderInternal<B>(
    () =>
      new MapReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function choose<A, B>(
  mapping: (a: A) => B | undefined,
  set: aset<A>,
): aset<B> {
  if (set.isConstant) {
    return constant(() => force(set).choose(mapping));
  }
  return ofReaderInternal<B>(
    () =>
      new ChooseReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function filter<T>(
  predicate: (t: T) => boolean,
  set: aset<T>,
): aset<T> {
  if (set.isConstant) return constant(() => force(set).filter(predicate));
  return ofReaderInternal<T>(
    () =>
      new FilterReader<T>(set, predicate) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function collect<A, B>(
  mapping: (a: A) => aset<B>,
  set: aset<A>,
): aset<B> {
  return ofReaderInternal<B>(
    () =>
      new CollectReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

/** `collect'` — variant for plain seq-returning mappings. */
export function collectSeq<A, B>(
  mapping: (a: A) => Iterable<B>,
  set: aset<A>,
): aset<B> {
  return ofReaderInternal<B>(
    () =>
      new CollectSeqReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function unionMany<T>(sets: aset<aset<T>>): aset<T> {
  return ofReaderInternal<T>(
    () =>
      new UnionReader<T>(sets) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function union<T>(a: aset<T>, b: aset<T>): aset<T> {
  if (a.isConstant && b.isConstant) {
    return constant(() => force(a).unionWith(force(b)));
  }
  // Implement as collect over a 2-element set.
  return unionMany(ofList<aset<T>>([a, b]));
}

export function difference<T>(a: aset<T>, b: aset<T>): aset<T> {
  if (a.isConstant && b.isConstant) {
    return constant(() => force(a).exceptWith(force(b)));
  }
  return ofReaderInternal<T>(
    () =>
      new DifferenceReader<T>(a, b) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function intersect<T>(a: aset<T>, b: aset<T>): aset<T> {
  if (a.isConstant && b.isConstant) {
    return constant(() => force(a).intersectWith(force(b)));
  }
  return ofReaderInternal<T>(
    () =>
      new IntersectReader<T>(a, b) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function xor<T>(a: aset<T>, b: aset<T>): aset<T> {
  if (a.isConstant && b.isConstant) {
    return constant(() => force(a).symmetricExceptWith(force(b)));
  }
  return ofReaderInternal<T>(
    () =>
      new XorReader<T>(a, b) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

/**
 * Reader for `range`: emits Add/Rem deltas as the integer range
 * `[lower, upper]` shifts. Specialised for `number`.
 */
class SetRangeReader extends AbstractReader<HashSetDelta<number>> {
  private readonly _lower: aval<number>;
  private readonly _upper: aval<number>;
  private _lastMin = 0;
  private _lastMax = -1;
  constructor(lower: aval<number>, upper: aval<number>) {
    super(HashSetDelta.empty<number>());
    this._lower = lower;
    this._upper = upper;
  }
  override compute(tok: AdaptiveToken): HashSetDelta<number> {
    const newMin = this._lower.getValue(tok) | 0;
    const newMax = this._upper.getValue(tok) | 0;
    let delta = HashSetDelta.empty<number>();

    const oldEmpty = this._lastMax < this._lastMin;
    const newEmpty = newMax < newMin;

    if (oldEmpty && newEmpty) {
      // nothing
    } else if (oldEmpty) {
      for (let i = newMin; i <= newMax; i++)
        delta = delta.combine(HashSetDelta.single(SetOperation.add(i)));
    } else if (newEmpty) {
      for (let i = this._lastMin; i <= this._lastMax; i++)
        delta = delta.combine(HashSetDelta.single(SetOperation.rem(i)));
    } else {
      // Add new elements not in the old range.
      for (let i = newMin; i <= newMax; i++) {
        if (i < this._lastMin || i > this._lastMax) {
          delta = delta.combine(HashSetDelta.single(SetOperation.add(i)));
        }
      }
      // Remove old elements not in the new range.
      for (let i = this._lastMin; i <= this._lastMax; i++) {
        if (i < newMin || i > newMax) {
          delta = delta.combine(HashSetDelta.single(SetOperation.rem(i)));
        }
      }
    }
    this._lastMin = newMin;
    this._lastMax = newMax;
    return delta;
  }
}

/**
 * Adaptive integer range as an `aset<number>`. Order is undefined
 * (it's a set); see `AList.range` for an ordered list.
 *
 * PORT NOTE: specialised for `number`. F# does not have an
 * `ASet.range` — this is a TS-side convenience matching `AList.range`.
 */
export function range(
  lower: aval<number>,
  upper: aval<number>,
): aset<number> {
  if (lower.isConstant && upper.isConstant) {
    const lo = AVal.force(lower) | 0;
    const hi = AVal.force(upper) | 0;
    const arr: number[] = [];
    for (let i = lo; i <= hi; i++) arr.push(i);
    return ofArray(arr);
  }
  return ofReaderInternal<number>(
    () =>
      new SetRangeReader(lower, upper) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<number>
      >,
  );
}

export function ofAVal<T>(value: aval<Iterable<T>>): aset<T> {
  if (value.isConstant) {
    return constant(() => HashSet.ofSeq(AVal.force(value)));
  }
  return ofReaderInternal<T>(
    () =>
      new AValReader<Iterable<T>, T>(value) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function bind<A, B>(
  mapping: (a: A) => aset<B>,
  value: aval<A>,
): aset<B> {
  if (value.isConstant) {
    return mapping(AVal.force(value));
  }
  return ofReaderInternal<B>(
    () =>
      new BindReader<A, B>(value, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function flattenA<T>(set: aset<aval<T>>): aset<T> {
  return ofReaderInternal<T>(
    () =>
      new FlattenAReader<T>(set) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<T>
      >,
  );
}

export function mapA<A, B>(
  mapping: (a: A) => aval<B>,
  set: aset<A>,
): aset<B> {
  return ofReaderInternal<B>(
    () =>
      new MapAReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function chooseA<A, B>(
  mapping: (a: A) => aval<B | undefined>,
  set: aset<A>,
): aset<B> {
  return ofReaderInternal<B>(
    () =>
      new ChooseAReader<A, B>(set, mapping) as unknown as IOpReaderWithState<
        unknown,
        HashSetDelta<B>
      >,
  );
}

export function filterA<T>(
  predicate: (t: T) => aval<boolean>,
  set: aset<T>,
): aset<T> {
  // Implement filterA via chooseA — equivalent semantics, simpler code.
  return chooseA<T, T>(
    (v) => predicate(v).map((p) => (p ? v : undefined)),
    set,
  );
}

// ---------------------------------------------------------------------------
// AVal-returning ASet operations
// ---------------------------------------------------------------------------

/** Adaptively tests if the set is empty. */
export function isEmpty<T>(set: aset<T>): aval<boolean> {
  return set.content.map((s) => s.isEmpty);
}

/** Adaptively gets the number of elements in the set. */
export function count<T>(set: aset<T>): aval<number> {
  return set.content.map((s) => s.count);
}

/** Adaptively checks whether `value` is in the set. */
/**
 * Adaptively whether the set contains `value`. Incremental:
 * tracks a refCount for `value` across deltas and reports
 * `refCount > 0`. Mirrors F#'s `SetReductions.ContainsValue`.
 */
export function contains<T>(value: T, set: aset<T>): aval<boolean> {
  return new ContainsValueASet<T>(set, value);
}

class ContainsValueASet<T> extends AbstractVal<boolean> {
  private readonly _reader: IHashSetReader<T>;
  private readonly _value: T;
  private _refCount = 0;
  constructor(input: aset<T>, value: T) {
    super();
    this._reader = input.getReader();
    this._value = value;
  }
  override compute(tok: AdaptiveToken): boolean {
    const ops = this._reader.getChanges(tok).store;
    const delta = ops.tryFind(this._value);
    if (delta !== undefined) this._refCount += delta;
    return this._refCount > 0;
  }
}

/**
 * Adaptively checks whether the predicate holds for all entries.
 * Mirrors F#: `reduceBy (countNegative |> mapOut (= 0)) predicate set`.
 */
export function forall<T>(
  predicate: (t: T) => boolean,
  set: aset<T>,
): aval<boolean> {
  return reduceBy<T, boolean, number, boolean>(
    Reductions.mapOut((n: number) => n === 0, Reductions.countNegative),
    predicate,
    set,
  );
}

/**
 * Adaptively checks whether the predicate holds for at least one
 * entry. Mirrors F#: `reduceBy (countPositive |> mapOut (<> 0)) predicate set`.
 */
export function exists<T>(
  predicate: (t: T) => boolean,
  set: aset<T>,
): aval<boolean> {
  return reduceBy<T, boolean, number, boolean>(
    Reductions.mapOut((n: number) => n !== 0, Reductions.countPositive),
    predicate,
    set,
  );
}

/**
 * Adaptively counts elements where the predicate holds. Mirrors F#:
 * `reduceBy countPositive predicate set`.
 */
export function countBy<T>(
  predicate: (t: T) => boolean,
  set: aset<T>,
): aval<number> {
  return reduceBy<T, boolean, number, number>(
    Reductions.countPositive,
    predicate,
    set,
  );
}

// ---------------------------------------------------------------------------
// ReduceValueASet — incremental reduction over set elements.
// Mirrors F#'s SetReductions.ReduceValue (AdaptiveHashSet.fs).
// ---------------------------------------------------------------------------

class ReduceValueASet<T, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<T, S, V>;
  private readonly _reader: IHashSetReader<T>;
  // F# `mutable sum : 's` (always-valid). The bulk-recompute branch
  // resets `sum`; the incremental branch breaks out via `working`.
  private _sum: S;

  constructor(reduction: AdaptiveReduction<T, S, V>, set: aset<T>) {
    super();
    this._reduction = reduction;
    this._reader = set.getReader();
    this._sum = reduction.seed;
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);
    const stateCount = this._reader.state.count;

    if (stateCount <= 2 || stateCount <= ops.count) {
      // Bulk recompute (F# `if reader.State.Count <= 2 || ... then`).
      let s = this._reduction.seed;
      for (const v of this._reader.state) s = this._reduction.add(s, v);
      this._sum = s;
    } else {
      let working = true;
      for (const op of ops) {
        if (!working) break;
        if (op.count === 1) {
          this._sum = this._reduction.add(this._sum, op.value);
        } else if (op.count === -1) {
          const r = this._reduction.sub(this._sum, op.value);
          if (r === undefined) {
            working = false;
          } else {
            this._sum = r;
          }
        }
      }
      if (!working) {
        // Inverse failed — recompute from the current set state.
        let s = this._reduction.seed;
        for (const v of this._reader.state) s = this._reduction.add(s, v);
        this._sum = s;
      }
    }
    return this._reduction.view(this._sum);
  }
}

// ---------------------------------------------------------------------------
// ReduceByValueASet — incremental reduction with sync element mapping.
// Mirrors F#'s SetReductions.ReduceByValue (AdaptiveHashSet.fs).
// ---------------------------------------------------------------------------

class ReduceByValueASet<T, B, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<B, S, V>;
  private readonly _mapping: (t: T) => B;
  private readonly _reader: IHashSetReader<T>;
  private _state: HashMap<T, B> = HashMap.empty<T, B>();
  private _sum: S | undefined;

  constructor(
    reduction: AdaptiveReduction<B, S, V>,
    mapping: (t: T) => B,
    set: aset<T>,
  ) {
    super();
    this._reduction = reduction;
    this._mapping = mapping;
    this._reader = set.getReader();
    this._sum = reduction.seed;
  }

  private add(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.add(s, v);
  }
  private sub(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.sub(s, v);
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);
    const stateCount = this._reader.state.count;

    if (stateCount <= 2 || stateCount <= ops.count) {
      // Bulk recompute path: rebuild state by reusing cached mappings
      // for unchanged elements.
      let newState = HashMap.empty<T, B>();
      for (const a of this._reader.state) {
        const cached = this._state.tryFind(a);
        const b = cached !== undefined ? cached : this._mapping(a);
        newState = newState.add(a, b);
      }
      let s = this._reduction.seed;
      for (const [, v] of newState) s = this._reduction.add(s, v);
      this._state = newState;
      this._sum = s;
      return this._reduction.view(s);
    }

    // Incremental.
    for (const op of ops) {
      if (op.count === 1) {
        const old = this._state.tryFind(op.value);
        if (old !== undefined) this._sum = this.sub(this._sum, old);
        const b = this._mapping(op.value);
        this._sum = this.add(this._sum, b);
        this._state = this._state.add(op.value, b);
      } else if (op.count === -1) {
        const old = this._state.tryFind(op.value);
        if (old !== undefined) {
          this._state = this._state.remove(op.value);
          this._sum = this.sub(this._sum, old);
        }
      }
    }

    if (this._sum === undefined) {
      // Inverse failed at some point — full recompute.
      let s = this._reduction.seed;
      for (const [, v] of this._state) s = this._reduction.add(s, v);
      this._sum = s;
    }
    return this._reduction.view(this._sum);
  }
}

// ---------------------------------------------------------------------------
// AdaptiveReduceByValueASet — incremental reduction over aset elements
// each mapped through an aval. Mirrors F#'s
// SetReductions.AdaptiveReduceByValue (AdaptiveHashSet.fs).
// ---------------------------------------------------------------------------

class AdaptiveReduceByValueASet<T, B, S, V> extends AbstractVal<V> {
  private readonly _reduction: AdaptiveReduction<B, S, V>;
  private readonly _mapping: (t: T) => aval<B>;
  private readonly _reader: IHashSetReader<T>;

  // Per-element bookkeeping: aval used for the element and the last
  // observed B value.
  private _state: HashMap<T, [aval<B>, B]> = HashMap.empty<T, [aval<B>, B]>();
  // Reverse index: aval -> set of indices observing it. Used in
  // inputChanged to mark the right indices dirty when an aval fires.
  private _targets: MultiSetMap<aval<B>, T> = MultiSetMap.empty<aval<B>, T>();
  // Indices whose aval changed since last evaluate. Drained on
  // compute().
  private _dirty: HashMap<T, aval<B>> = HashMap.empty<T, aval<B>>();
  // Running sum. Cleared to undefined when the inverse fails.
  private _sum: S | undefined;
  private _seeded = false;

  constructor(
    reduction: AdaptiveReduction<B, S, V>,
    mapping: (t: T) => aval<B>,
    set: aset<T>,
  ) {
    super();
    this._reduction = reduction;
    this._mapping = mapping;
    this._reader = set.getReader();
    (this._reader as unknown as IAdaptiveObject).tag = "FoldReader";
    this._sum = reduction.seed;
    this._seeded = true;
  }

  override inputChanged(_t: unknown, o: IAdaptiveObject): void {
    // Distinguish the input reader (tagged) from any aval observed
    // through `this._mapping`.
    if (o.tag === "FoldReader") return;
    const indices = MultiSetMap.find(
      o as unknown as aval<B>,
      this._targets,
    );
    for (const i of indices) {
      this._dirty = this._dirty.add(i, o as unknown as aval<B>);
    }
  }

  private add(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.add(s, v);
  }

  private sub(s: S | undefined, v: B): S | undefined {
    if (s === undefined) return undefined;
    return this._reduction.sub(s, v);
  }

  private removeIndex(i: T): void {
    const cur = this._state.tryFind(i);
    if (cur === undefined) return;
    const [ov, o] = cur;
    this._state = this._state.remove(i);
    this._sum = this.sub(this._sum, o);
    const r = MultiSetMap.remove(ov, i, this._targets);
    this._targets = r.result;
    if (r.wasLast) (ov as unknown as IAdaptiveObject).outputs.remove(this);
  }

  override compute(tok: AdaptiveToken): V {
    const ops = this._reader.getChanges(tok);

    if (
      this._reader.state.count <= 2 ||
      this._reader.state.count <= ops.count
    ) {
      // Bulk-reset path: drop all targets, re-pull every aval.
      this._dirty = HashMap.empty<T, aval<B>>();
      for (const [m] of this._targets) {
        (m as unknown as IAdaptiveObject).outputs.remove(this);
      }
      this._targets = MultiSetMap.empty<aval<B>, T>();

      let newState = HashMap.empty<T, [aval<B>, B]>();
      for (const [k] of this._reader.state.toHashMap()) {
        const old = this._state.tryFind(k);
        if (old !== undefined) {
          const [m] = old;
          const v = m.getValue(tok);
          this._targets = MultiSetMap.add(m, k, this._targets);
          newState = newState.add(k, [m, v]);
        } else {
          const m = this._mapping(k);
          const v = m.getValue(tok);
          this._targets = MultiSetMap.add(m, k, this._targets);
          newState = newState.add(k, [m, v]);
        }
      }
      this._state = newState;
      let s = this._reduction.seed;
      for (const [, [, v]] of newState) s = this._reduction.add(s, v);
      this._sum = s;
      this._seeded = true;
      return this._reduction.view(s);
    }

    // Incremental path.
    let dirty = this._dirty;
    this._dirty = HashMap.empty<T, aval<B>>();

    for (const op of ops) {
      dirty = dirty.remove(op.value);
      if (op.count === 1) {
        // Add: ensure clean state for this index, then mapping + add.
        this.removeIndex(op.value);
        const r = this._mapping(op.value);
        const n = r.getValue(tok);
        this._targets = MultiSetMap.add(r, op.value, this._targets);
        this._state = this._state.add(op.value, [r, n]);
        this._sum = this.add(this._sum, n);
      } else if (op.count === -1) {
        this.removeIndex(op.value);
      }
    }

    for (const [i, r] of dirty) {
      const n = r.getValue(tok);
      const cur = this._state.tryFind(i);
      if (cur !== undefined) {
        const [ro, o] = cur;
        // ro should equal r; refresh the value entry.
        this._sum = this.add(this.sub(this._sum, o), n);
        this._state = this._state.add(i, [ro, n]);
      } else {
        // Index isn't tracked anymore; ignore the dirty signal.
      }
    }

    if (this._sum === undefined) {
      // Inverse failed at some point — recompute from scratch.
      let s = this._reduction.seed;
      for (const [, [, v]] of this._state) s = this._reduction.add(s, v);
      this._sum = s;
    }
    this._seeded = true;
    return this._reduction.view(this._sum);
  }
}

/**
 * Adaptively reduces the set using the given `AdaptiveReduction`.
 * Incremental: applies `add`/`sub` per delta op and only bulk-
 * recomputes when the delta is bigger than the state or `sub`
 * fails. Mirrors F#'s `SetReductions.ReduceValue`.
 */
export function reduce<T, S, V>(
  reduction: AdaptiveReduction<T, S, V>,
  set: aset<T>,
): aval<V> {
  return new ReduceValueASet<T, S, V>(reduction, set);
}

/**
 * Adaptively reduces the set after mapping each element through a
 * synchronous `mapping`. Maintains a per-element cache of mapped
 * values and adds/subtracts incrementally per delta op.
 * Mirrors F#'s `SetReductions.ReduceByValue`.
 */
export function reduceBy<T1, T2, S, V>(
  reduction: AdaptiveReduction<T2, S, V>,
  mapping: (t: T1) => T2,
  set: aset<T1>,
): aval<V> {
  return new ReduceByValueASet<T1, T2, S, V>(reduction, mapping, set);
}

/**
 * Adaptively reduces the set after mapping each element to an `aval`.
 * Incremental version: tracks per-element aval observations through a
 * `MultiSetMap`, applies group-style add/sub when sets change, and
 * falls back to a full recompute only when the inverse fails.
 */
export function reduceByA<T, B, S, V>(
  reduction: AdaptiveReduction<B, S, V>,
  mapping: (t: T) => aval<B>,
  set: aset<T>,
): aval<V> {
  return new AdaptiveReduceByValueASet<T, B, S, V>(reduction, mapping, set);
}

/** Sum of all numeric elements. Incremental via `reduce`. */
export function sum(set: aset<number>): aval<number> {
  return reduce<number, number, number>(Reductions.sum, set);
}

/** Adaptively counts elements where the aval-valued predicate holds. */
export function countByA<T>(
  predicate: (t: T) => aval<boolean>,
  set: aset<T>,
): aval<number> {
  return reduceByA(Reductions.countPositive, predicate, set);
}

/**
 * Adaptively checks whether the aval-valued predicate holds for at
 * least one element.
 */
export function existsA<T>(
  predicate: (t: T) => aval<boolean>,
  set: aset<T>,
): aval<boolean> {
  return reduceByA<T, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n !== 0,
      Reductions.countPositive,
    ),
    predicate,
    set,
  );
}

/**
 * Adaptively checks whether the aval-valued predicate holds for all
 * elements.
 */
export function forallA<T>(
  predicate: (t: T) => aval<boolean>,
  set: aset<T>,
): aval<boolean> {
  return reduceByA<T, boolean, number, boolean>(
    Reductions.mapOut(
      (n: number) => n === 0,
      Reductions.countNegative,
    ),
    predicate,
    set,
  );
}

/** Adaptively sums the aval-valued mapping over the set. */
export function sumByA<T>(
  mapping: (t: T) => aval<number>,
  set: aset<T>,
): aval<number> {
  return reduceByA(Reductions.sum, mapping, set);
}

/** Adaptively averages the aval-valued mapping over the set. */
export function averageByA<T>(
  mapping: (t: T) => aval<number>,
  set: aset<T>,
): aval<number> {
  return reduceByA(Reductions.average, mapping, set);
}

/** Average of all numeric elements (NaN for empty). Incremental via `reduce`. */
export function average(set: aset<number>): aval<number> {
  return reduce<number, [number, number], number>(Reductions.average, set);
}

/** Sum of mapped numeric values. Incremental via `reduceBy`. */
export function sumBy<T>(
  mapping: (t: T) => number,
  set: aset<T>,
): aval<number> {
  return reduceBy<T, number, number, number>(Reductions.sum, mapping, set);
}

/** Average of mapped numeric values. Incremental via `reduceBy`. */
export function averageBy<T>(
  mapping: (t: T) => number,
  set: aset<T>,
): aval<number> {
  return reduceBy<T, number, [number, number], number>(
    Reductions.average,
    mapping,
    set,
  );
}

/**
 * Adaptively folds with `add` (no inverse). Mirrors F#:
 * `reduce (AdaptiveReduction.fold zero add) set`. The reduction's
 * `sub` always fails, so the underlying `ReduceValue` will bulk
 * recompute on every removal — matching F#'s `fold` semantics.
 */
export function fold<T, S>(
  add: (s: S, v: T) => S,
  zero: S,
  set: aset<T>,
): aval<S> {
  return reduce<T, S, S>(Reductions.fold(zero, add), set);
}

/**
 * Adaptively folds with `add` and inverse `subtract`. Incremental:
 * `subtract` is consulted on every removal, no recompute needed.
 * Mirrors F#: `reduce (AdaptiveReduction.group zero add subtract) set`.
 */
export function foldGroup<T, S>(
  add: (s: S, v: T) => S,
  subtract: (s: S, v: T) => S,
  zero: S,
  set: aset<T>,
): aval<S> {
  return reduce<T, S, S>(Reductions.group(zero, add, subtract), set);
}

/**
 * Adaptively folds with `add` and partial inverse `trySubtract`.
 * When `trySubtract` returns `undefined` the running sum is
 * invalidated and bulk-recomputed at the end of the tick.
 * Mirrors F#: `reduce (AdaptiveReduction.halfGroup zero add trySub) set`.
 */
export function foldHalfGroup<T, S>(
  add: (s: S, v: T) => S,
  trySubtract: (s: S, v: T) => S | undefined,
  zero: S,
  set: aset<T>,
): aval<S> {
  return reduce<T, S, S>(Reductions.halfGroup(zero, add, trySubtract), set);
}

/**
 * Adaptively the smallest element (or `undefined`). Incremental via
 * `reduce` with `AdaptiveReduction.tryMin`. Mirrors F#'s `tryMin`.
 */
export function tryMin<T>(
  set: aset<T>,
  compare?: (a: T, b: T) => number,
): aval<T | undefined> {
  const cmp = compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
  return reduce<T, T | undefined, T | undefined>(Reductions.tryMin(cmp), set);
}

/**
 * Adaptively the largest element (or `undefined`). Incremental via
 * `reduce` with `AdaptiveReduction.tryMax`. Mirrors F#'s `tryMax`.
 */
export function tryMax<T>(
  set: aset<T>,
  compare?: (a: T, b: T) => number,
): aval<T | undefined> {
  const cmp = compare ?? ((a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0));
  return reduce<T, T | undefined, T | undefined>(Reductions.tryMax(cmp), set);
}

// ---------------------------------------------------------------------------
// N-ary combinators — `zip` wrapper
// ---------------------------------------------------------------------------

type AValValuesSet<T extends ReadonlyArray<aval<unknown>>> = {
  [K in keyof T]: T[K] extends aval<infer U> ? U : never;
};

export class SetZipped<Ts extends readonly unknown[]> {
  private readonly _avals: ReadonlyArray<aval<unknown>>;
  constructor(avals: ReadonlyArray<aval<unknown>>) { this._avals = avals; }
  bind<R>(f: (...vs: Ts) => aset<R>): aset<R> {
    const avals = this._avals;
    const tuple: aval<Ts> = AVal.custom((tok) => {
      return avals.map((v) => (v as unknown as { getValue(t: AdaptiveToken): unknown }).getValue(tok)) as unknown as Ts;
    });
    return bind((t) => f(...t), tuple);
  }
}

export function zip<T extends readonly aval<unknown>[]>(...vals: T): SetZipped<AValValuesSet<T>> {
  return new SetZipped<AValValuesSet<T>>(vals);
}

// ---------------------------------------------------------------------------
// Convenience namespace
// ---------------------------------------------------------------------------

export const ASet = {
  empty,
  constant,
  single,
  ofSeq,
  ofList,
  ofArray,
  ofHashSet,
  range,
  toAVal,
  ofReader,
  custom,
  map,
  choose,
  filter,
  collect,
  collectSeq,
  union,
  unionMany,
  difference,
  intersect,
  xor,
  ofAVal,
  bind,
  flattenA,
  mapA,
  chooseA,
  filterA,
  isEmpty,
  count,
  contains,
  forall,
  exists,
  countBy,
  countByA,
  reduce,
  reduceBy,
  reduceByA,
  existsA,
  forallA,
  sumByA,
  averageByA,
  sum,
  sumBy,
  average,
  averageBy,
  fold,
  foldGroup,
  foldHalfGroup,
  tryMin,
  tryMax,
  force,
  zip,
};
