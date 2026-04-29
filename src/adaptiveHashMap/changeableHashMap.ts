// Port of FSharp.Data.Adaptive AdaptiveHashMap/ChangeableHashMap.fs

import { AVal, type aval } from "../adaptiveValue/adaptiveValue.js";
import { transactIfNecessary } from "../core/transaction.js";
import { HashMap } from "../datastructures/hashCollections.js";
import { HashMapDelta } from "../datastructures/hashMapDelta.js";
import {
  ElementSet,
  ElementRemove,
  type ElementOperation,
} from "../datastructures/operations.js";
import { HashMapDeltaExt } from "../datastructures/deltas.js";
import { hashMapTrace } from "../traceable/hashMapTraceable.js";
import { History } from "../traceable/history.js";
import type { amap, IHashMapReader } from "./adaptiveHashMap.js";

/**
 * Changeable adaptive map that allows mutation by user-code and
 * implements `amap`.
 */
export class ChangeableHashMap<K, V>
  implements amap<K, V>, Iterable<[K, V]>
{
  readonly isConstant = false;
  readonly history: History<HashMap<K, V>, HashMapDelta<K, V>>;
  readonly content: aval<HashMap<K, V>>;

  constructor(initial?: HashMap<K, V> | Iterable<[K, V]>) {
    const init =
      initial === undefined
        ? HashMap.empty<K, V>()
        : initial instanceof HashMap
          ? initial
          : HashMap.ofSeq<K, V>(initial);

    this.history = History.create(hashMapTrace<K, V>());
    if (!init.isEmpty) {
      const delta = HashMapDeltaExt.computeDelta(HashMap.empty<K, V>(), init);
      this.history.perform(delta);
    }
    const hist = this.history;
    this.content = AVal.custom((tok) => {
      hist.getValue(tok);
      return hist.state;
    });
  }

  get count(): number {
    return this.history.state.count;
  }
  get isEmpty(): boolean {
    return this.history.state.isEmpty;
  }
  containsKey(key: K): boolean {
    return this.history.state.containsKey(key);
  }
  tryGetValue(key: K): V | undefined {
    return this.history.state.tryFind(key);
  }

  clear(): void {
    if (!this.history.state.isEmpty) {
      const ops = HashMapDeltaExt.computeDelta(
        this.history.state,
        HashMap.empty<K, V>(),
      );
      this.history.perform(ops);
    }
  }

  get value(): HashMap<K, V> {
    return this.history.state;
  }
  set value(v: HashMap<K, V>) {
    this.updateTo(v);
  }

  /** Sets the current state as HashMap. Returns whether anything changed. */
  updateTo(target: HashMap<K, V>): boolean {
    const cur = this.history.state;
    if (!cur.equals(target)) {
      const delta = HashMapDeltaExt.computeDelta(cur, target);
      if (delta.isEmpty) return false;
      return this.history.performUnsafe(target, delta);
    }
    return false;
  }

  /**
   * Sets the current state by reconciling with another map of a
   * different value type using `init` for new keys and `update` for
   * existing ones.
   */
  updateToWithInit<T2>(
    target: HashMap<K, T2>,
    init: (t: T2) => V,
    update: (existing: V, t: T2) => V,
  ): void {
    const current = this.history.state;
    const store = current.choose2V<T2, ElementOperation<V>>(
      target,
      (_k, l, r) => {
        if (l === undefined) {
          if (r === undefined) return undefined;
          return ElementSet(init(r));
        }
        if (r === undefined) return ElementRemove;
        const nl = update(l, r);
        if (Object.is(l, nl)) return undefined;
        return ElementSet(nl);
      },
    );
    const ops = HashMapDelta.ofHashMap(store);
    this.history.perform(ops);
  }

  /** Performs the given operations on the Map. */
  perform(operations: HashMapDelta<K, V>): void {
    if (!operations.isEmpty) this.history.perform(operations);
  }

  /** Removes the entry for the given key. */
  remove(key: K): boolean {
    return this.history.perform(
      HashMapDelta.ofHashMap<K, V>(
        HashMap.single<K, ElementOperation<V>>(key, ElementRemove),
      ),
    );
  }

  /** Adds (or replaces) the given key/value pair. */
  add(key: K, value: V): boolean {
    return this.history.perform(
      HashMapDelta.ofHashMap<K, V>(
        HashMap.single<K, ElementOperation<V>>(key, ElementSet(value)),
      ),
    );
  }

  get(key: K): V | undefined {
    return this.history.state.tryFind(key);
  }
  set(key: K, value: V): void {
    this.history.perform(
      HashMapDelta.ofHashMap<K, V>(
        HashMap.single<K, ElementOperation<V>>(key, ElementSet(value)),
      ),
    );
  }

  getReader(): IHashMapReader<K, V> {
    return this.history.newReader();
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    yield* this.history.state;
  }

  toString(): string {
    const items = [...this.history.state]
      .slice(0, 5)
      .map(([k, v]) => `${String(k)}=>${String(v)}`)
      .join("; ");
    return `cmap [${items}${this.count > 5 ? "; ..." : ""}]`;
  }
}

export type cmap<K, V> = ChangeableHashMap<K, V>;

/** Creates a cmap. */
export function cmap<K, V>(
  initial?: HashMap<K, V> | Iterable<[K, V]>,
): ChangeableHashMap<K, V> {
  return new ChangeableHashMap<K, V>(initial);
}

export const ChangeableHashMapOps = {
  empty: <K, V>() => new ChangeableHashMap<K, V>(),
  ofSeq: <K, V>(s: Iterable<[K, V]>) => new ChangeableHashMap<K, V>(s),
  ofHashMap: <K, V>(m: HashMap<K, V>) => new ChangeableHashMap<K, V>(m),
  add: <K, V>(c: ChangeableHashMap<K, V>, k: K, v: V) =>
    transactIfNecessary(() => c.add(k, v)),
  remove: <K, V>(c: ChangeableHashMap<K, V>, k: K) =>
    transactIfNecessary(() => c.remove(k)),
  clear: <K, V>(c: ChangeableHashMap<K, V>) =>
    transactIfNecessary(() => c.clear()),
  updateTo: <K, V>(c: ChangeableHashMap<K, V>, m: HashMap<K, V>) =>
    transactIfNecessary(() => c.updateTo(m)),
  perform: <K, V>(c: ChangeableHashMap<K, V>, ops: HashMapDelta<K, V>) =>
    transactIfNecessary(() => c.perform(ops)),
};
