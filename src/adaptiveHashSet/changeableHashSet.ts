// Port of FSharp.Data.Adaptive AdaptiveHashSet/ChangeableHashSet.fs

import { AVal, type aval } from "../adaptiveValue/adaptiveValue.js";
import { transactIfNecessary } from "../core/transaction.js";
import {
  HashMap,
  HashSet,
} from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { SetOperation } from "../datastructures/operations.js";
import {
  CountingHashSet,
} from "../traceable/countingHashSet.js";
import { History } from "../traceable/history.js";
import type { aset, IHashSetReader } from "./adaptiveHashSet.js";

/**
 * Changeable adaptive set that allows mutation by user-code and
 * implements `aset`.
 */
export class ChangeableHashSet<T> implements aset<T>, Iterable<T> {
  readonly isConstant = false;
  readonly history: History<CountingHashSet<T>, HashSetDelta<T>>;
  readonly content: aval<HashSet<T>>;

  constructor(initial?: HashSet<T> | Iterable<T>) {
    const init =
      initial === undefined
        ? HashSet.empty<T>()
        : initial instanceof HashSet
          ? initial
          : HashSet.ofSeq<T>(initial);

    this.history = History.create(CountingHashSet.traceNoRefCount<T>());
    if (!init.isEmpty) {
      const delta = HashSetDelta.ofHashMap(
        HashSet.empty<T>().computeDeltaAsHashMapStd(init),
      );
      this.history.perform(delta);
    }
    const hist = this.history;
    this.content = AVal.custom((tok) => {
      hist.getValue(tok);
      return hist.state.toHashSet();
    });
  }

  /** The number of entries currently in the set. */
  get count(): number {
    return this.history.state.count;
  }

  /** Is the set currently empty? */
  get isEmpty(): boolean {
    return this.history.state.isEmpty;
  }

  /** Checks whether the given value is contained. */
  contains(value: T): boolean {
    return this.history.state.contains(value);
  }

  /** Gets the current state as `HashSet`. */
  get value(): HashSet<T> {
    return AVal.force(this.content);
  }
  /** Sets the current state as `HashSet`. */
  set value(newSet: HashSet<T>) {
    this.updateTo(newSet);
  }

  /** Sets the current state as `HashSet`. Returns whether anything changed. */
  updateTo(newSet: HashSet<T>): boolean {
    const current = this.history.state.toHashSet();
    if (!current.setEquals(newSet)) {
      const delta = HashSetDelta.ofHashMap(
        current.computeDeltaAsHashMapStd(newSet),
      );
      return this.history.perform(delta);
    }
    return false;
  }

  /** Performs the given operations on the set. */
  perform(operations: HashSetDelta<T>): void {
    if (!operations.isEmpty) {
      this.history.perform(operations);
    }
  }

  /** Adds a value and returns whether the element was new. */
  add(value: T): boolean {
    return this.history.perform(HashSetDelta.single(SetOperation.add(value)));
  }

  /** Removes a value and returns whether the element was deleted. */
  remove(value: T): boolean {
    return this.history.perform(HashSetDelta.single(SetOperation.rem(value)));
  }

  /** Clears the set. */
  clear(): void {
    if (!this.history.state.isEmpty) {
      const ops = this.history.state.computeDelta(CountingHashSet.empty<T>());
      this.history.perform(ops);
    }
  }

  /** Adds all the given values to the set. */
  unionWith(other: Iterable<T>): void {
    let m = HashMap.empty<T, number>();
    for (const v of other) m = m.add(v, 1);
    this.perform(HashSetDelta.ofHashMap(m));
  }

  /** Removes all the given elements from the set. */
  exceptWith(other: Iterable<T>): void {
    let m = HashMap.empty<T, number>();
    for (const v of other) m = m.add(v, -1);
    this.perform(HashSetDelta.ofHashMap(m));
  }

  symmetricExceptWith(other: Iterable<T>): void {
    const otherSet = CountingHashSet.ofSeq(other);
    const lhs = this.history.state.toHashMap();
    const rhs = otherSet.toHashMap();
    const delta = lhs.choose2V<number, number>(rhs, (_k, l, r) => {
      if (l !== undefined) {
        if (r !== undefined) return -l;
        return undefined;
      } else {
        if (r !== undefined) return 1;
        return undefined;
      }
    });
    this.perform(HashSetDelta.ofHashMap(delta));
  }

  /** Removes all elements from the set that are not also contained in other. */
  intersectWith(other: Iterable<T>): void {
    const otherSet = HashSet.ofSeq(other);
    const stateMap = this.history.state.toHashMap();
    const { effective } = HashMap.applyDeltaToSet<T, number, number>(
      otherSet,
      stateMap,
      (_k: T, inOther: boolean, myRefCnt: number) => {
        if (!inOther && myRefCnt > 0) return [false, -myRefCnt];
        return [false, undefined];
      },
    );
    this.perform(HashSetDelta.ofHashMap(effective));
  }

  /** Creates an adaptive reader for the set. */
  getReader(): IHashSetReader<T> {
    return this.history.newReader();
  }

  *[Symbol.iterator](): IterableIterator<T> {
    yield* this.value;
  }

  toString(): string {
    const items = [...this.history.state]
      .slice(0, 5)
      .map((x) => String(x))
      .join("; ");
    return `cset [${items}${this.count > 5 ? "; ..." : ""}]`;
  }
}

/** Alias matching the F# `cset<'T>` shorthand. */
export type cset<T> = ChangeableHashSet<T>;

/** Creates an empty cset. */
export function cset<T>(initial?: HashSet<T> | Iterable<T>): ChangeableHashSet<T> {
  return new ChangeableHashSet<T>(initial);
}

/**
 * Mutates the cset under an automatic transaction (no-op if a
 * transaction is already in flight).
 */
export const ChangeableHashSetOps = {
  empty: <T>() => new ChangeableHashSet<T>(),
  ofSeq: <T>(elements: Iterable<T>) => new ChangeableHashSet<T>(elements),
  ofHashSet: <T>(set: HashSet<T>) => new ChangeableHashSet<T>(set),
  add: <T>(set: ChangeableHashSet<T>, value: T): boolean =>
    transactIfNecessary(() => set.add(value)),
  remove: <T>(set: ChangeableHashSet<T>, value: T): boolean =>
    transactIfNecessary(() => set.remove(value)),
  clear: <T>(set: ChangeableHashSet<T>): void =>
    transactIfNecessary(() => set.clear()),
  unionWith: <T>(set: ChangeableHashSet<T>, other: Iterable<T>): void =>
    transactIfNecessary(() => set.unionWith(other)),
  exceptWith: <T>(set: ChangeableHashSet<T>, other: Iterable<T>): void =>
    transactIfNecessary(() => set.exceptWith(other)),
  intersectWith: <T>(set: ChangeableHashSet<T>, other: Iterable<T>): void =>
    transactIfNecessary(() => set.intersectWith(other)),
  symmetricExceptWith: <T>(set: ChangeableHashSet<T>, other: Iterable<T>): void =>
    transactIfNecessary(() => set.symmetricExceptWith(other)),
  updateTo: <T>(set: ChangeableHashSet<T>, value: HashSet<T>): boolean =>
    transactIfNecessary(() => set.updateTo(value)),
  perform: <T>(set: ChangeableHashSet<T>, ops: HashSetDelta<T>): void =>
    transactIfNecessary(() => set.perform(ops)),
};
