// Port of FSharp.Data.Adaptive Datastructures/Deltas.fs
//
// PORT NOTE: the IndexList delta and the Myers diff (DeltaOperationList64 +
// ofArrayMyers) live in `indexListDeltas.ts` once IndexList is ported.
// This file only carries the HashSet/HashMap delta entries.

import { HashMap, HashSet } from "./hashCollections.js";
import { HashMapDelta } from "./hashMapDelta.js";
import { HashSetDelta } from "./hashSetDelta.js";
import {
  ElementRemove,
  ElementSet,
  type ElementOperation,
} from "./operations.js";

// ---------------------------------------------------------------------------
// HashSet delta operators
// ---------------------------------------------------------------------------

export const HashSetDeltaExt = {
  /**
   * Determines the operations needed to transform `l` into `r`, using
   * custom add/remove element operation functions. Each receives the
   * key and may return undefined to skip emission.
   */
  computeDeltaCustom: <T>(
    l: HashSet<T>,
    r: HashSet<T>,
    add: (k: T) => boolean,
    remove: (k: T) => boolean,
  ): HashSetDelta<T> => {
    const delta = l.computeDeltaAsHashMap<number>(
      r,
      (k) => (remove(k) ? -1 : undefined),
      (k) => (add(k) ? 1 : undefined),
    );
    return HashSetDelta.ofHashMap(delta);
  },

  /**
   * Determines the operations needed to transform `l` into `r`.
   * Returns a HashSetDelta containing these operations.
   */
  computeDelta: <T>(l: HashSet<T>, r: HashSet<T>): HashSetDelta<T> => {
    return HashSetDelta.ofHashMap(l.computeDeltaAsHashMapStd(r));
  },

  /** Same as `computeDelta set empty`. */
  removeAll: <T>(set: HashSet<T>): HashSetDelta<T> => {
    let m = HashMap.empty<T, number>();
    for (const k of set) m = m.add(k, -1);
    return HashSetDelta.ofHashMap(m);
  },

  /** Same as `computeDelta empty set`. */
  addAll: <T>(set: HashSet<T>): HashSetDelta<T> => {
    let m = HashMap.empty<T, number>();
    for (const k of set) m = m.add(k, 1);
    return HashSetDelta.ofHashMap(m);
  },

  /**
   * Applies a delta to the set. Returns the new set and the
   * 'effective' operations (entries whose net effect actually changed
   * the set). Mirrors `HashSet.applyDelta` in F#.
   */
  applyDelta: <T>(
    value: HashSet<T>,
    delta: HashSetDelta<T>,
  ): { state: HashSet<T>; delta: HashSetDelta<T> } => {
    const apply = (
      _k: T,
      existing: boolean,
      n: number,
    ): [boolean, number | undefined] => {
      if (n < 0) {
        if (existing) return [false, -1];
        return [false, undefined];
      } else if (n > 0) {
        if (existing) return [true, undefined];
        return [true, 1];
      } else {
        return [existing, undefined];
      }
    };
    const result = HashMap.applyDeltaToSet<T, number, number>(
      value,
      delta.toMap(),
      apply,
    );
    return {
      state: result.state,
      delta: HashSetDelta.ofHashMap(result.effective),
    };
  },
};

// ---------------------------------------------------------------------------
// HashMap delta operators
// ---------------------------------------------------------------------------

export const HashMapDeltaExt = {
  /**
   * Determines the operations needed to transform `l` into `r`, using
   * custom add/remove/update element operation functions. Each
   * callback returns the optional operation; undefined means
   * "no-op for this key".
   */
  computeDeltaCustom: <K, V>(
    add: (k: K, v: V) => ElementOperation<V> | undefined,
    remove: (k: K, v: V) => ElementOperation<V> | undefined,
    update: (k: K, oldV: V, newV: V) => ElementOperation<V> | undefined,
    l: HashMap<K, V>,
    r: HashMap<K, V>,
  ): HashMapDelta<K, V> => {
    let out = HashMap.empty<K, ElementOperation<V>>();
    // entries in l: either removed (not in r) or updated (in r).
    for (const [k, lv] of l) {
      const rv = r.tryFind(k);
      if (rv === undefined && !r.containsKey(k)) {
        const op = remove(k, lv);
        if (op !== undefined) out = out.add(k, op);
      } else {
        const op = update(k, lv, rv as V);
        if (op !== undefined) out = out.add(k, op);
      }
    }
    // entries in r not in l: added.
    for (const [k, rv] of r) {
      if (!l.containsKey(k)) {
        const op = add(k, rv);
        if (op !== undefined) out = out.add(k, op);
      }
    }
    return HashMapDelta.ofHashMap(out);
  },

  /** Determines the operations needed to transform `l` into `r`. */
  computeDelta: <K, V>(
    l: HashMap<K, V>,
    r: HashMap<K, V>,
  ): HashMapDelta<K, V> => {
    return HashMapDeltaExt.computeDeltaCustom<K, V>(
      (_k, v) => ElementSet(v),
      (_k, _v) => ElementRemove,
      (_k, ov, nv) => (Object.is(ov, nv) ? undefined : ElementSet(nv)),
      l,
      r,
    );
  },

  /**
   * Applies a delta to the map. Returns the new map and the effective
   * operations.
   */
  applyDelta: <K, V>(
    state: HashMap<K, V>,
    delta: HashMapDelta<K, V>,
  ): { state: HashMap<K, V>; delta: HashMapDelta<K, V> } => {
    const apply = (
      _k: K,
      existing: V | undefined,
      op: ElementOperation<V>,
    ): [V | undefined, ElementOperation<V> | undefined] => {
      if (op.tag === "Remove") {
        if (existing !== undefined) return [undefined, ElementRemove];
        return [undefined, undefined];
      }
      // op.tag === "Set"
      if (existing !== undefined) {
        if (Object.is(existing, op.value)) return [op.value, undefined];
        return [op.value, ElementSet(op.value)];
      }
      return [op.value, ElementSet(op.value)];
    };
    const result = HashMap.applyDeltaV<K, V, ElementOperation<V>, ElementOperation<V>>(
      state,
      delta.store,
      apply,
    );
    return {
      state: result.state,
      delta: HashMapDelta.ofHashMap(result.effective),
    };
  },
};
