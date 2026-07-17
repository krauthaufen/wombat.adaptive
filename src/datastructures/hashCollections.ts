// Port of FSharp.Data.Adaptive Datastructures/HashCollections.fs
//
// Faithful HAMT (hash-array-mapped trie) port. Replaces the prior
// pragmatic Map-backed placeholder. Public API is unchanged.
//
// PORT NOTE — uint32 arithmetic:
//   F# uses `uint32` for tags, prefixes, masks, and hashes. JS bit
//   operators (`<<`, `>>>`, `|`, `&`, `^`, `~`) operate on 32-bit
//   integers; `>>> 0` coerces a value to its unsigned-32 view. The bit
//   helpers below assume their inputs are already non-negative
//   uint32-shaped numbers; comparisons across the high-bit boundary
//   are routed through `>>> 0` where uint32 ordering matters.
//
// PORT NOTE — node hierarchy:
//   F#'s `SetNode<K>` is an abstract base packing `(data << 1) | kind`
//   into a single uint32 field. `SetLeaf` and `MapLeaf` and `Inner`
//   extend it. We mirror that with a TS class hierarchy + an `isLeaf`
//   flag (we don't bit-pack; a discriminator field is fine).
//
// PORT NOTE — locks/threading:
//   F# uses thread-locals nowhere here; pure value-type code. No
//   threading concerns to translate.

import {
  comparerFor,
  defaultComparer,
  type IEqualityComparer,
} from "./equality.js";

// ---------------------------------------------------------------------------
// HashNumberCrunching — bit-twiddling primitives
// ---------------------------------------------------------------------------

/** Mix two 32-bit hash values. */
function combineHash(a: number, b: number): number {
  return (((a ^ b) + 0x9e3779b9) + (a << 6) + (a >>> 2)) | 0;
}

/** Returns the most-significant bit set in `x` (e.g. 0b00101100 -> 0b00100000). */
function highestBitMask(x: number): number {
  let v = x >>> 0;
  v = v | (v >>> 1);
  v = v | (v >>> 2);
  v = v | (v >>> 4);
  v = v | (v >>> 8);
  v = v | (v >>> 16);
  return (v ^ (v >>> 1)) >>> 0;
}

/** Returns `k` with all bits at or below `m` cleared. */
function getPrefix(k: number, m: number): number {
  // F#: k & ~((m << 1) - 1)
  const allBelow = (((m << 1) >>> 0) - 1) >>> 0;
  return (k & ~allBelow) >>> 0;
}

/** 0 if bit `m` is clear in `k`, 1 if set. */
function zeroBit(k: number, m: number): number {
  return (k & m) !== 0 ? 1 : 0;
}

/** 0 / 1 if `hash` falls inside `prefix`/`m`, else 2 (the "doesn't match" branch). */
function matchPrefixAndGetBit(
  hash: number,
  prefix: number,
  m: number,
): number {
  if (getPrefix(hash, m) === prefix) return zeroBit(hash, m);
  return 2;
}

/**
 * F# returns `compare r l` (note swapped order — bigger mask first).
 * Compares uint32 values.
 */
function compareMasks(l: number, m: number): number {
  const lu = l >>> 0;
  const mu = m >>> 0;
  if (mu < lu) return -1;
  if (mu > lu) return 1;
  return 0;
}

/** Mask isolating the highest bit at which `p0` and `p1` differ. */
function getMask(p0: number, p1: number): number {
  return highestBitMask(((p0 ^ p1) >>> 0));
}

// ---------------------------------------------------------------------------
// Linked-list collision chains
// ---------------------------------------------------------------------------

/** Linked list of keys sharing the same hash (collision chain on the leaf). */
class SetLinked<K> {
  key: K;
  setNext: SetLinked<K> | null;

  constructor(key: K, next: SetLinked<K> | null) {
    this.key = key;
    this.setNext = next;
  }
}

/**
 * Linked list of (key, value) pairs sharing the same hash. Inherits
 * from SetLinked to mirror F#'s subclass relationship — `mapNext`
 * downcasts `setNext` to `MapLinked` when iterating maps.
 */
class MapLinked<K, V> extends SetLinked<K> {
  value: V;

  constructor(key: K, value: V, next: MapLinked<K, V> | null) {
    super(key, next);
    this.value = value;
  }

  get mapNext(): MapLinked<K, V> | null {
    return this.setNext as MapLinked<K, V> | null;
  }
  set mapNext(v: MapLinked<K, V> | null) {
    this.setNext = v;
  }
}

// ---------------------------------------------------------------------------
// SetNode hierarchy: SetNode (abstract) ← SetLeaf ← MapLeaf  + Inner
// ---------------------------------------------------------------------------

abstract class SetNode<K> {
  abstract readonly isLeaf: boolean;
}

class SetLeaf<K> extends SetNode<K> {
  readonly isLeaf = true;
  hash: number;
  key: K;
  setNext: SetLinked<K> | null;

  constructor(hash: number, key: K, next: SetLinked<K> | null) {
    super();
    this.hash = hash >>> 0;
    this.key = key;
    this.setNext = next;
  }
}

class MapLeaf<K, V> extends SetLeaf<K> {
  value: V;

  constructor(
    hash: number,
    key: K,
    value: V,
    next: MapLinked<K, V> | null,
  ) {
    super(hash, key, next);
    this.value = value;
  }

  get mapNext(): MapLinked<K, V> | null {
    return this.setNext as MapLinked<K, V> | null;
  }
  set mapNext(v: MapLinked<K, V> | null) {
    this.setNext = v;
  }
}

class Inner<K> extends SetNode<K> {
  readonly isLeaf = false;
  prefix: number;
  mask: number;
  count: number;
  left: SetNode<K> | null;
  right: SetNode<K> | null;

  constructor(
    prefix: number,
    mask: number,
    left: SetNode<K> | null,
    right: SetNode<K> | null,
  ) {
    super();
    this.prefix = prefix >>> 0;
    this.mask = mask >>> 0;
    this.count = Inner.getCount(left) + Inner.getCount(right);
    this.left = left;
    this.right = right;
  }

  static getCount<K>(node: SetNode<K> | null): number {
    if (node === null) return 0;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (leaf.setNext === null) return 1;
      let c = 1;
      let cur: SetLinked<K> | null = leaf.setNext;
      while (cur !== null) {
        c += 1;
        cur = cur.setNext;
      }
      return c;
    }
    return (node as Inner<K>).count;
  }
}

function size<K>(node: SetNode<K> | null): number {
  return Inner.getCount(node);
}

// ---------------------------------------------------------------------------
// SetLinked operations (faithful port of F# `module SetLinked`)
// ---------------------------------------------------------------------------

const SetLinkedOps = {
  add<K>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: SetLinked<K> | null,
  ): SetLinked<K> {
    if (n === null) return new SetLinked<K>(key, null);
    if (cmp.equals(n.key, key)) return n;
    return new SetLinked<K>(n.key, SetLinkedOps.add(cmp, key, n.setNext));
  },

  alter<K>(
    cmp: IEqualityComparer<K>,
    key: K,
    update: (existed: boolean) => boolean,
    n: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (n === null) {
      if (update(false)) return new SetLinked<K>(key, null);
      return null;
    }
    if (cmp.equals(key, n.key)) {
      return update(true) ? n : n.setNext;
    }
    const next = SetLinkedOps.alter(cmp, key, update, n.setNext);
    return new SetLinked<K>(n.key, next);
  },

  contains<K>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: SetLinked<K> | null,
  ): boolean {
    let cur: SetLinked<K> | null = n;
    while (cur !== null) {
      if (cmp.equals(cur.key, key)) return true;
      cur = cur.setNext;
    }
    return false;
  },

  filter<K>(
    predicate: (k: K) => boolean,
    n: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (n === null) return null;
    if (predicate(n.key)) {
      return new SetLinked<K>(n.key, SetLinkedOps.filter(predicate, n.setNext));
    }
    return SetLinkedOps.filter(predicate, n.setNext);
  },

  /** Removes the first match. Returns [removed, newList]. */
  tryRemove<K>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: SetLinked<K> | null,
  ): [boolean, SetLinked<K> | null] {
    if (n === null) return [false, null];
    if (cmp.equals(key, n.key)) return [true, n.setNext];
    const [ok, next] = SetLinkedOps.tryRemove(cmp, key, n.setNext);
    if (ok) return [true, new SetLinked<K>(n.key, next)];
    return [false, n];
  },

  equals<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): boolean {
    if (a === null) return b === null;
    if (b === null) return false;
    const [ok, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    if (!ok) return false;
    return SetLinkedOps.equals(cmp, a.setNext, rest);
  },

  toList<K>(acc: K[], n: SetLinked<K> | null): K[] {
    if (n === null) return acc;
    acc.push(n.key);
    return SetLinkedOps.toList(acc, n.setNext);
  },

  mapToMap<K, V>(
    mapping: (k: K) => V,
    n: SetLinked<K> | null,
  ): MapLinked<K, V> | null {
    if (n === null) return null;
    return new MapLinked<K, V>(
      n.key,
      mapping(n.key),
      SetLinkedOps.mapToMap(mapping, n.setNext),
    );
  },

  chooseToMapV<K, V>(
    mapping: (k: K) => V | undefined,
    n: SetLinked<K> | null,
  ): MapLinked<K, V> | null {
    if (n === null) return null;
    const v = mapping(n.key);
    if (v !== undefined) {
      return new MapLinked<K, V>(
        n.key,
        v,
        SetLinkedOps.chooseToMapV(mapping, n.setNext),
      );
    }
    return SetLinkedOps.chooseToMapV(mapping, n.setNext);
  },

  union<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (a === null) return b;
    if (b === null) return a;
    const [, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    return new SetLinked<K>(a.key, SetLinkedOps.union(cmp, a.setNext, rest));
  },

  xor<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (a === null) return b;
    if (b === null) return a;
    const [ok, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    if (ok) return SetLinkedOps.xor(cmp, a.setNext, rest);
    return new SetLinked<K>(a.key, SetLinkedOps.xor(cmp, a.setNext, rest));
  },

  difference<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (a === null) return null;
    if (b === null) return a;
    const [, ra] = SetLinkedOps.tryRemove(cmp, b.key, a);
    return SetLinkedOps.difference(cmp, ra, b.setNext);
  },

  intersect<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): SetLinked<K> | null {
    if (a === null || b === null) return null;
    const [ok, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    if (ok) {
      return new SetLinked<K>(
        a.key,
        SetLinkedOps.intersect(cmp, a.setNext, rest),
      );
    }
    return SetLinkedOps.intersect(cmp, a.setNext, b);
  },

  intersectionCount<K>(
    cmp: IEqualityComparer<K>,
    acc: number,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): number {
    if (a === null || b === null) return acc;
    const [ok, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    if (ok) return SetLinkedOps.intersectionCount(cmp, acc + 1, a.setNext, rest);
    return SetLinkedOps.intersectionCount(cmp, acc, a.setNext, b);
  },

  overlaps<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): boolean {
    if (a === null || b === null) return false;
    if (SetLinkedOps.contains(cmp, a.key, b)) return true;
    if (SetLinkedOps.contains(cmp, b.key, a)) return true;
    return SetLinkedOps.overlaps(cmp, a.setNext, b.setNext);
  },

  subset<K>(
    cmp: IEqualityComparer<K>,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): boolean {
    if (a === null) return true;
    if (b === null) return false;
    if (!SetLinkedOps.contains(cmp, a.key, b)) return false;
    return SetLinkedOps.subset(cmp, a.setNext, b);
  },

  computeDelta<K, OP>(
    cmp: IEqualityComparer<K>,
    onlyLeft: (k: K) => OP | undefined,
    onlyRight: (k: K) => OP | undefined,
    a: SetLinked<K> | null,
    b: SetLinked<K> | null,
  ): MapLinked<K, OP> | null {
    if (a === null) return SetLinkedOps.chooseToMapV(onlyRight, b);
    if (b === null) return SetLinkedOps.chooseToMapV(onlyLeft, a);
    const [ok, rest] = SetLinkedOps.tryRemove(cmp, a.key, b);
    if (ok) {
      return SetLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, a.setNext, rest);
    }
    const op = onlyLeft(a.key);
    if (op === undefined) {
      return SetLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, a.setNext, b);
    }
    return new MapLinked<K, OP>(
      a.key,
      op,
      SetLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, a.setNext, b),
    );
  },

  applyDeltaNoState<K, D, DOut>(
    apply: (
      k: K,
      existed: boolean,
      d: D,
    ) => [boolean, DOut | undefined],
    delta: MapLinked<K, D> | null,
  ): [MapLinked<K, DOut> | null, SetLinked<K> | null] {
    if (delta === null) return [null, null];
    const [exists, op] = apply(delta.key, false, delta.value);
    const [restDelta, restState] = SetLinkedOps.applyDeltaNoState(
      apply,
      delta.mapNext,
    );
    const state = exists ? new SetLinked<K>(delta.key, restState) : restState;
    if (op !== undefined) {
      return [new MapLinked<K, DOut>(delta.key, op, restDelta), state];
    }
    return [restDelta, state];
  },

  applyDelta<K, D, DOut>(
    cmp: IEqualityComparer<K>,
    apply: (
      k: K,
      existed: boolean,
      d: D,
    ) => [boolean, DOut | undefined],
    delta: MapLinked<K, D> | null,
    state: SetLinked<K> | null,
  ): [MapLinked<K, DOut> | null, SetLinked<K> | null] {
    if (state === null) {
      return SetLinkedOps.applyDeltaNoState(apply, delta);
    }
    if (delta === null) return [null, state];
    const [wasExisting, st0] = SetLinkedOps.tryRemove(cmp, delta.key, state);
    const [exists, op] = apply(delta.key, wasExisting, delta.value);
    const [restDelta, st1] = SetLinkedOps.applyDelta(
      cmp,
      apply,
      delta.mapNext,
      st0,
    );
    const newState = exists ? new SetLinked<K>(delta.key, st1) : st1;
    if (op !== undefined) {
      return [new MapLinked<K, DOut>(delta.key, op, restDelta), newState];
    }
    return [restDelta, newState];
  },
};

// ---------------------------------------------------------------------------
// MapLinked operations (faithful port of F# `module MapLinked`)
// ---------------------------------------------------------------------------

const MapLinkedOps = {
  add<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    value: V,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, V> {
    if (n === null) return new MapLinked<K, V>(key, value, null);
    if (cmp.equals(n.key, key)) return new MapLinked<K, V>(key, value, n.mapNext);
    return new MapLinked<K, V>(
      n.key,
      n.value,
      MapLinkedOps.add(cmp, key, value, n.mapNext),
    );
  },

  alter<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    update: (existing: V | undefined) => V | undefined,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    if (n === null) {
      const v = update(undefined);
      if (v === undefined) return null;
      return new MapLinked<K, V>(key, v, null);
    }
    if (cmp.equals(n.key, key)) {
      const v = update(n.value);
      if (v === undefined) return n.mapNext;
      return new MapLinked<K, V>(key, v, n.mapNext);
    }
    const next = MapLinkedOps.alter(cmp, key, update, n.mapNext);
    return new MapLinked<K, V>(n.key, n.value, next);
  },

  alterV<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    update: (existing: V | undefined) => V | undefined,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    return MapLinkedOps.alter(cmp, key, update, n);
  },

  tryRemove<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: MapLinked<K, V> | null,
  ): [V | undefined, MapLinked<K, V> | null] {
    if (n === null) return [undefined, null];
    if (cmp.equals(key, n.key)) return [n.value, n.mapNext];
    const [v, next] = MapLinkedOps.tryRemove(cmp, key, n.mapNext);
    if (v === undefined) return [undefined, n];
    return [v, new MapLinked<K, V>(n.key, n.value, next)];
  },

  tryFind<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: MapLinked<K, V> | null,
  ): V | undefined {
    let cur: MapLinked<K, V> | null = n;
    while (cur !== null) {
      if (cmp.equals(cur.key, key)) return cur.value;
      cur = cur.mapNext;
    }
    return undefined;
  },

  containsKey<K, V>(
    cmp: IEqualityComparer<K>,
    key: K,
    n: MapLinked<K, V> | null,
  ): boolean {
    let cur: MapLinked<K, V> | null = n;
    while (cur !== null) {
      if (cmp.equals(cur.key, key)) return true;
      cur = cur.mapNext;
    }
    return false;
  },

  toList<K, V>(acc: Array<[K, V]>, n: MapLinked<K, V> | null): Array<[K, V]> {
    if (n === null) return acc;
    acc.push([n.key, n.value]);
    return MapLinkedOps.toList(acc, n.mapNext);
  },

  toValueList<K, V>(acc: V[], n: MapLinked<K, V> | null): V[] {
    if (n === null) return acc;
    acc.push(n.value);
    return MapLinkedOps.toValueList(acc, n.mapNext);
  },

  fold<K, V, S>(
    folder: (s: S, k: K, v: V) => S,
    state: S,
    n: MapLinked<K, V> | null,
  ): S {
    let cur = n;
    let s = state;
    while (cur !== null) {
      s = folder(s, cur.key, cur.value);
      cur = cur.mapNext;
    }
    return s;
  },

  exists<K, V>(
    predicate: (k: K, v: V) => boolean,
    n: MapLinked<K, V> | null,
  ): boolean {
    let cur = n;
    while (cur !== null) {
      if (predicate(cur.key, cur.value)) return true;
      cur = cur.mapNext;
    }
    return false;
  },

  forall<K, V>(
    predicate: (k: K, v: V) => boolean,
    n: MapLinked<K, V> | null,
  ): boolean {
    let cur = n;
    while (cur !== null) {
      if (!predicate(cur.key, cur.value)) return false;
      cur = cur.mapNext;
    }
    return true;
  },

  equals<K, V>(
    cmp: IEqualityComparer<K>,
    a: MapLinked<K, V> | null,
    b: MapLinked<K, V> | null,
  ): boolean {
    if (a === null) return b === null;
    if (b === null) return false;
    const [vb, rest] = MapLinkedOps.tryRemove(cmp, a.key, b);
    if (vb === undefined) return false;
    if (!Object.is(a.value, vb)) return false;
    return MapLinkedOps.equals(cmp, a.mapNext, rest);
  },

  map<K, V, T>(
    mapping: (k: K, v: V) => T,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, T> | null {
    if (n === null) return null;
    return new MapLinked<K, T>(
      n.key,
      mapping(n.key, n.value),
      MapLinkedOps.map(mapping, n.mapNext),
    );
  },

  filter<K, V>(
    predicate: (k: K, v: V) => boolean,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    if (n === null) return null;
    if (predicate(n.key, n.value)) {
      return new MapLinked<K, V>(
        n.key,
        n.value,
        MapLinkedOps.filter(predicate, n.mapNext),
      );
    }
    return MapLinkedOps.filter(predicate, n.mapNext);
  },

  choose<K, V, T>(
    mapping: (k: K, v: V) => T | undefined,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, T> | null {
    if (n === null) return null;
    const t = mapping(n.key, n.value);
    if (t !== undefined) {
      return new MapLinked<K, T>(
        n.key,
        t,
        MapLinkedOps.choose(mapping, n.mapNext),
      );
    }
    return MapLinkedOps.choose(mapping, n.mapNext);
  },

  chooseV<K, V, T>(
    mapping: (k: K, v: V) => T | undefined,
    n: MapLinked<K, V> | null,
  ): MapLinked<K, T> | null {
    return MapLinkedOps.choose(mapping, n);
  },

  intersect<K, A, B, C>(
    cmp: IEqualityComparer<K>,
    resolve: (k: K, a: A, b: B) => C,
    a: MapLinked<K, A> | null,
    b: MapLinked<K, B> | null,
  ): MapLinked<K, C> | null {
    if (a === null || b === null) return null;
    const [vb, rest] = MapLinkedOps.tryRemove(cmp, a.key, b);
    if (vb !== undefined) {
      return new MapLinked<K, C>(
        a.key,
        resolve(a.key, a.value, vb),
        MapLinkedOps.intersect(cmp, resolve, a.mapNext, rest),
      );
    }
    return MapLinkedOps.intersect(cmp, resolve, a.mapNext, b);
  },

  union<K, V>(
    cmp: IEqualityComparer<K>,
    a: MapLinked<K, V> | null,
    b: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    if (a === null) return b;
    if (b === null) return a;
    const [, rest] = MapLinkedOps.tryRemove(cmp, b.key, a);
    return new MapLinked<K, V>(
      b.key,
      b.value,
      MapLinkedOps.union(cmp, rest, b.mapNext),
    );
  },

  unionWith<K, V>(
    cmp: IEqualityComparer<K>,
    resolve: (k: K, l: V, r: V) => V,
    a: MapLinked<K, V> | null,
    b: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    if (a === null) return b;
    if (b === null) return a;
    const [aV, rest] = MapLinkedOps.tryRemove(cmp, b.key, a);
    if (aV !== undefined) {
      return new MapLinked<K, V>(
        b.key,
        resolve(b.key, aV, b.value),
        MapLinkedOps.unionWith(cmp, resolve, rest, b.mapNext),
      );
    }
    return new MapLinked<K, V>(
      b.key,
      b.value,
      MapLinkedOps.unionWith(cmp, resolve, rest, b.mapNext),
    );
  },

  unionWithV<K, V>(
    cmp: IEqualityComparer<K>,
    resolve: (k: K, l: V, r: V) => V | undefined,
    a: MapLinked<K, V> | null,
    b: MapLinked<K, V> | null,
  ): MapLinked<K, V> | null {
    if (a === null) return b;
    if (b === null) return a;
    const [aV, rest] = MapLinkedOps.tryRemove(cmp, b.key, a);
    if (aV !== undefined) {
      const v = resolve(b.key, aV, b.value);
      if (v !== undefined) {
        return new MapLinked<K, V>(
          b.key,
          v,
          MapLinkedOps.unionWithV(cmp, resolve, rest, b.mapNext),
        );
      }
      return MapLinkedOps.unionWithV(cmp, resolve, rest, b.mapNext);
    }
    return new MapLinked<K, V>(
      b.key,
      b.value,
      MapLinkedOps.unionWithV(cmp, resolve, rest, b.mapNext),
    );
  },

  computeDelta<K, V, OP>(
    cmp: IEqualityComparer<K>,
    onlyLeft: (k: K, v: V) => OP | undefined,
    onlyRight: (k: K, v: V) => OP | undefined,
    both: (k: K, l: V, r: V) => OP | undefined,
    a: MapLinked<K, V> | null,
    b: MapLinked<K, V> | null,
  ): MapLinked<K, OP> | null {
    if (a === null) return MapLinkedOps.chooseV(onlyRight, b);
    if (b === null) return MapLinkedOps.chooseV(onlyLeft, a);
    const [bV, rest] = MapLinkedOps.tryRemove(cmp, a.key, b);
    if (bV !== undefined) {
      const op = both(a.key, a.value, bV);
      if (op !== undefined) {
        return new MapLinked<K, OP>(
          a.key,
          op,
          MapLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.mapNext, rest),
        );
      }
      return MapLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.mapNext, rest);
    }
    const op = onlyLeft(a.key, a.value);
    if (op !== undefined) {
      return new MapLinked<K, OP>(
        a.key,
        op,
        MapLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.mapNext, b),
      );
    }
    return MapLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.mapNext, b);
  },

  choose2VLeft<K, A, B, C>(
    mapping: (k: K, a: A | undefined, b: B | undefined) => C | undefined,
    a: MapLinked<K, A> | null,
  ): MapLinked<K, C> | null {
    if (a === null) return null;
    const c = mapping(a.key, a.value, undefined);
    const rest = MapLinkedOps.choose2VLeft(mapping, a.mapNext);
    if (c !== undefined) return new MapLinked<K, C>(a.key, c, rest);
    return rest;
  },

  choose2VRight<K, A, B, C>(
    mapping: (k: K, a: A | undefined, b: B | undefined) => C | undefined,
    b: MapLinked<K, B> | null,
  ): MapLinked<K, C> | null {
    if (b === null) return null;
    const c = mapping(b.key, undefined, b.value);
    const rest = MapLinkedOps.choose2VRight(mapping, b.mapNext);
    if (c !== undefined) return new MapLinked<K, C>(b.key, c, rest);
    return rest;
  },

  choose2V<K, A, B, C>(
    cmp: IEqualityComparer<K>,
    mapping: (k: K, a: A | undefined, b: B | undefined) => C | undefined,
    a: MapLinked<K, A> | null,
    b: MapLinked<K, B> | null,
  ): MapLinked<K, C> | null {
    if (a === null) return MapLinkedOps.choose2VRight(mapping, b);
    if (b === null) return MapLinkedOps.choose2VLeft(mapping, a);
    const [bV, rest] = MapLinkedOps.tryRemove(cmp, a.key, b);
    if (bV !== undefined) {
      const c = mapping(a.key, a.value, bV);
      const out = MapLinkedOps.choose2V(cmp, mapping, a.mapNext, rest);
      if (c !== undefined) return new MapLinked<K, C>(a.key, c, out);
      return out;
    }
    const c = mapping(a.key, a.value, undefined);
    const out = MapLinkedOps.choose2V(cmp, mapping, a.mapNext, b);
    if (c !== undefined) return new MapLinked<K, C>(a.key, c, out);
    return out;
  },

  applyDeltaNoState<K, V, D, DOut>(
    apply: (
      k: K,
      existing: V | undefined,
      d: D,
    ) => [V | undefined, DOut | undefined],
    delta: MapLinked<K, D> | null,
  ): [MapLinked<K, DOut> | null, MapLinked<K, V> | null] {
    if (delta === null) return [null, null];
    const [newValue, op] = apply(delta.key, undefined, delta.value);
    const [restDelta, restState] = MapLinkedOps.applyDeltaNoState(
      apply,
      delta.mapNext,
    );
    const state =
      newValue !== undefined
        ? new MapLinked<K, V>(delta.key, newValue, restState)
        : restState;
    if (op !== undefined) {
      return [new MapLinked<K, DOut>(delta.key, op, restDelta), state];
    }
    return [restDelta, state];
  },

  applyDelta<K, V, D, DOut>(
    cmp: IEqualityComparer<K>,
    apply: (
      k: K,
      existing: V | undefined,
      d: D,
    ) => [V | undefined, DOut | undefined],
    delta: MapLinked<K, D> | null,
    state: MapLinked<K, V> | null,
  ): [MapLinked<K, DOut> | null, MapLinked<K, V> | null] {
    if (state === null) {
      return MapLinkedOps.applyDeltaNoState(apply, delta);
    }
    if (delta === null) return [null, state];
    const [wasExisting, st0] = MapLinkedOps.tryRemove(cmp, delta.key, state);
    const [newValue, op] = apply(delta.key, wasExisting, delta.value);
    const [restDelta, st1] = MapLinkedOps.applyDelta(cmp, apply, delta.mapNext, st0);
    const ns =
      newValue !== undefined ? new MapLinked<K, V>(delta.key, newValue, st1) : st1;
    if (op !== undefined) {
      return [new MapLinked<K, DOut>(delta.key, op, restDelta), ns];
    }
    return [restDelta, ns];
  },
};

// ---------------------------------------------------------------------------
// SetNode operations (HAMT for sets)
// ---------------------------------------------------------------------------

function nodeJoin<K>(
  p0: number,
  t0: SetNode<K> | null,
  p1: number,
  t1: SetNode<K> | null,
): SetNode<K> | null {
  if (t0 === null) return t1;
  if (t1 === null) return t0;
  const m = getMask(p0, p1);
  const prefix = getPrefix(p0, m);
  if (zeroBit(p0, m) === 0) return new Inner<K>(prefix, m, t0, t1);
  return new Inner<K>(prefix, m, t1, t0);
}

function nodeNewInner<K>(
  prefix: number,
  mask: number,
  l: SetNode<K> | null,
  r: SetNode<K> | null,
): SetNode<K> | null {
  if (l === null) return r;
  if (r === null) return l;
  return new Inner<K>(prefix, mask, l, r);
}

const SetNodeOps = {
  add<K>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): SetNode<K> {
    if (node === null) return new SetLeaf<K>(hash, key, null);
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (leaf.hash === hash) {
        if (cmp.equals(leaf.key, key)) return leaf;
        return new SetLeaf<K>(
          leaf.hash,
          leaf.key,
          SetLinkedOps.add(cmp, key, leaf.setNext),
        );
      }
      return nodeJoin(leaf.hash, leaf, hash, new SetLeaf<K>(hash, key, null))!;
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        SetNodeOps.add(cmp, hash, key, inner.left),
        inner.right,
      )!;
    }
    if (bit === 1) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        inner.left,
        SetNodeOps.add(cmp, hash, key, inner.right),
      )!;
    }
    return nodeJoin(inner.prefix, inner, hash, new SetLeaf<K>(hash, key, null))!;
  },

  alter<K>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    update: (existed: boolean) => boolean,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) {
      if (update(false)) return new SetLeaf<K>(hash, key, null);
      return null;
    }
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (leaf.hash === hash) {
        if (cmp.equals(leaf.key, key)) {
          if (update(true)) return leaf;
          const next = leaf.setNext;
          if (next === null) return null;
          return new SetLeaf<K>(leaf.hash, next.key, next.setNext);
        }
        return new SetLeaf<K>(
          leaf.hash,
          leaf.key,
          SetLinkedOps.alter(cmp, key, update, leaf.setNext),
        );
      }
      if (update(false)) {
        return nodeJoin(leaf.hash, leaf, hash, new SetLeaf<K>(hash, key, null));
      }
      return leaf;
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        SetNodeOps.alter(cmp, hash, key, update, inner.left),
        inner.right,
      );
    }
    if (bit === 1) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        inner.left,
        SetNodeOps.alter(cmp, hash, key, update, inner.right),
      );
    }
    if (update(false)) {
      return nodeJoin(inner.prefix, inner, hash, new SetLeaf<K>(hash, key, null));
    }
    return inner;
  },

  tryRemove<K>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): [boolean, SetNode<K> | null] {
    if (node === null) return [false, null];
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (leaf.hash !== hash) return [false, leaf];
      if (cmp.equals(key, leaf.key)) {
        const next = leaf.setNext;
        if (next === null) return [true, null];
        return [true, new SetLeaf<K>(leaf.hash, next.key, next.setNext)];
      }
      const [ok, next] = SetLinkedOps.tryRemove(cmp, key, leaf.setNext);
      if (ok) return [true, new SetLeaf<K>(leaf.hash, leaf.key, next)];
      return [false, leaf];
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      const [ok, l] = SetNodeOps.tryRemove(cmp, hash, key, inner.left);
      if (ok) return [true, nodeNewInner(inner.prefix, inner.mask, l, inner.right)];
      return [false, inner];
    }
    if (bit === 1) {
      const [ok, r] = SetNodeOps.tryRemove(cmp, hash, key, inner.right);
      if (ok) return [true, nodeNewInner(inner.prefix, inner.mask, inner.left, r)];
      return [false, inner];
    }
    return [false, inner];
  },

  contains<K>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): boolean {
    if (node === null) return false;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (leaf.hash !== hash) return false;
      if (cmp.equals(leaf.key, key)) return true;
      return SetLinkedOps.contains(cmp, key, leaf.setNext);
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) return SetNodeOps.contains(cmp, hash, key, inner.left);
    if (bit === 1) return SetNodeOps.contains(cmp, hash, key, inner.right);
    return false;
  },

  equals<K>(
    cmp: IEqualityComparer<K>,
    a: SetNode<K> | null,
    b: SetNode<K> | null,
  ): boolean {
    if (a === null) return b === null;
    if (b === null) return false;
    if (a === b) return true;
    if (a.isLeaf) {
      if (!b.isLeaf) return false;
      const aL = a as SetLeaf<K>;
      const bL = b as SetLeaf<K>;
      if (aL.hash !== bL.hash) return false;
      const la = new SetLinked<K>(aL.key, aL.setNext);
      const lb = new SetLinked<K>(bL.key, bL.setNext);
      return SetLinkedOps.equals(cmp, la, lb);
    }
    if (b.isLeaf) return false;
    const aI = a as Inner<K>;
    const bI = b as Inner<K>;
    if (aI.prefix !== bI.prefix || aI.mask !== bI.mask) return false;
    return (
      SetNodeOps.equals(cmp, aI.left, bI.left) &&
      SetNodeOps.equals(cmp, aI.right, bI.right)
    );
  },

  iter<K>(action: (k: K) => void, node: SetNode<K> | null): void {
    if (node === null) return;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      action(leaf.key);
      let cur = leaf.setNext;
      while (cur !== null) {
        action(cur.key);
        cur = cur.setNext;
      }
      return;
    }
    const inner = node as Inner<K>;
    SetNodeOps.iter(action, inner.left);
    SetNodeOps.iter(action, inner.right);
  },

  head<K>(node: SetNode<K> | null): K {
    if (node === null) throw new Error("HashSet does not contain any elements");
    if (node.isLeaf) return (node as SetLeaf<K>).key;
    return SetNodeOps.head((node as Inner<K>).left);
  },

  fold<K, S>(
    folder: (s: S, k: K) => S,
    state: S,
    node: SetNode<K> | null,
  ): S {
    if (node === null) return state;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      let s = folder(state, leaf.key);
      let cur = leaf.setNext;
      while (cur !== null) {
        s = folder(s, cur.key);
        cur = cur.setNext;
      }
      return s;
    }
    const inner = node as Inner<K>;
    const s = SetNodeOps.fold(folder, state, inner.left);
    return SetNodeOps.fold(folder, s, inner.right);
  },

  exists<K>(predicate: (k: K) => boolean, node: SetNode<K> | null): boolean {
    if (node === null) return false;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (predicate(leaf.key)) return true;
      let cur = leaf.setNext;
      while (cur !== null) {
        if (predicate(cur.key)) return true;
        cur = cur.setNext;
      }
      return false;
    }
    const inner = node as Inner<K>;
    return SetNodeOps.exists(predicate, inner.left) ||
      SetNodeOps.exists(predicate, inner.right);
  },

  forall<K>(predicate: (k: K) => boolean, node: SetNode<K> | null): boolean {
    if (node === null) return true;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (!predicate(leaf.key)) return false;
      let cur = leaf.setNext;
      while (cur !== null) {
        if (!predicate(cur.key)) return false;
        cur = cur.setNext;
      }
      return true;
    }
    const inner = node as Inner<K>;
    return SetNodeOps.forall(predicate, inner.left) &&
      SetNodeOps.forall(predicate, inner.right);
  },

  filter<K>(
    predicate: (k: K) => boolean,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      if (predicate(leaf.key)) {
        return new SetLeaf<K>(
          leaf.hash,
          leaf.key,
          SetLinkedOps.filter(predicate, leaf.setNext),
        );
      }
      const n = SetLinkedOps.filter(predicate, leaf.setNext);
      if (n === null) return null;
      return new SetLeaf<K>(leaf.hash, n.key, n.setNext);
    }
    const inner = node as Inner<K>;
    return nodeNewInner(
      inner.prefix,
      inner.mask,
      SetNodeOps.filter(predicate, inner.left),
      SetNodeOps.filter(predicate, inner.right),
    );
  },

  toList<K>(acc: K[], node: SetNode<K> | null): K[] {
    if (node === null) return acc;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      acc.push(leaf.key);
      return SetLinkedOps.toList(acc, leaf.setNext);
    }
    const inner = node as Inner<K>;
    const left = SetNodeOps.toList(acc, inner.left);
    return SetNodeOps.toList(left, inner.right);
  },

  mapToMap<K, V>(
    mapping: (k: K) => V,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      const v = mapping(leaf.key);
      return new MapLeaf<K, V>(
        leaf.hash,
        leaf.key,
        v,
        SetLinkedOps.mapToMap(mapping, leaf.setNext),
      );
    }
    const inner = node as Inner<K>;
    return new Inner<K>(
      inner.prefix,
      inner.mask,
      SetNodeOps.mapToMap(mapping, inner.left),
      SetNodeOps.mapToMap(mapping, inner.right),
    );
  },

  chooseToMapV<K, V>(
    mapping: (k: K) => V | undefined,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      const v = mapping(leaf.key);
      if (v !== undefined) {
        return new MapLeaf<K, V>(
          leaf.hash,
          leaf.key,
          v,
          SetLinkedOps.chooseToMapV(mapping, leaf.setNext),
        );
      }
      const next = SetLinkedOps.chooseToMapV(mapping, leaf.setNext);
      if (next === null) return null;
      return new MapLeaf<K, V>(leaf.hash, next.key, next.value, next.mapNext);
    }
    const inner = node as Inner<K>;
    return nodeNewInner(
      inner.prefix,
      inner.mask,
      SetNodeOps.chooseToMapV(mapping, inner.left),
      SetNodeOps.chooseToMapV(mapping, inner.right),
    );
  },

  union<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return nb;
    if (nb === null) return na;
    if (na === nb) return na;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          const res = SetLinkedOps.union(cmp, la, lb);
          if (res === null) return null;
          return new SetLeaf<K>(a.hash, res.key, res.setNext);
        }
        return nodeJoin(a.hash, na, b.hash, nb);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) {
        return nodeNewInner(b.prefix, b.mask, SetNodeOps.union(cmp, na, b.left), b.right);
      }
      if (bit === 1) {
        return nodeNewInner(b.prefix, b.mask, b.left, SetNodeOps.union(cmp, na, b.right));
      }
      return nodeJoin(a.hash, na, b.prefix, nb);
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.union(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.union(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.hash, nb);
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, SetNodeOps.union(cmp, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, SetNodeOps.union(cmp, na, b.right));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.union(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.union(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        SetNodeOps.union(cmp, a.left, b.left),
        SetNodeOps.union(cmp, a.right, b.right),
      );
    }
    return nodeJoin(a.prefix, na, b.prefix, nb);
  },

  intersect<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null || nb === null) return null;
    if (na === nb) return na;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          const res = SetLinkedOps.intersect(cmp, la, lb);
          if (res === null) return null;
          return new SetLeaf<K>(a.hash, res.key, res.setNext);
        }
        return null;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.intersect(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.intersect(cmp, na, b.right);
      return null;
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.intersect(cmp, a.left, nb);
      if (bit === 1) return SetNodeOps.intersect(cmp, a.right, nb);
      return null;
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.intersect(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.intersect(cmp, na, b.right);
      return null;
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.intersect(cmp, a.left, nb);
      if (bit === 1) return SetNodeOps.intersect(cmp, a.right, nb);
      return null;
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        SetNodeOps.intersect(cmp, a.left, b.left),
        SetNodeOps.intersect(cmp, a.right, b.right),
      );
    }
    return null;
  },

  intersectionCount<K>(
    cmp: IEqualityComparer<K>,
    acc: number,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): number {
    if (na === null || nb === null) return acc;
    if (na === nb) return acc + size(na);
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          return SetLinkedOps.intersectionCount(
            cmp,
            acc,
            new SetLinked<K>(a.key, a.setNext),
            new SetLinked<K>(b.key, b.setNext),
          );
        }
        return acc;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.intersectionCount(cmp, acc, na, b.left);
      if (bit === 1) return SetNodeOps.intersectionCount(cmp, acc, na, b.right);
      return acc;
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.intersectionCount(cmp, acc, a.left, nb);
      if (bit === 1) return SetNodeOps.intersectionCount(cmp, acc, a.right, nb);
      return acc;
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.intersectionCount(cmp, acc, na, b.left);
      if (bit === 1) return SetNodeOps.intersectionCount(cmp, acc, na, b.right);
      return acc;
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.intersectionCount(cmp, acc, a.left, nb);
      if (bit === 1) return SetNodeOps.intersectionCount(cmp, acc, a.right, nb);
      return acc;
    }
    if (a.prefix === b.prefix) {
      const acc1 = SetNodeOps.intersectionCount(cmp, acc, a.left, b.left);
      return SetNodeOps.intersectionCount(cmp, acc1, a.right, b.right);
    }
    return acc;
  },

  xor<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return nb;
    if (nb === null) return na;
    if (na === nb) return null;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          const res = SetLinkedOps.xor(cmp, la, lb);
          if (res === null) return null;
          return new SetLeaf<K>(a.hash, res.key, res.setNext);
        }
        return nodeJoin(a.hash, na, b.hash, nb);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, SetNodeOps.xor(cmp, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, SetNodeOps.xor(cmp, na, b.right));
      return nodeJoin(a.hash, na, b.prefix, nb);
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.xor(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.xor(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.hash, nb);
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, SetNodeOps.xor(cmp, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, SetNodeOps.xor(cmp, na, b.right));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.xor(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.xor(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        SetNodeOps.xor(cmp, a.left, b.left),
        SetNodeOps.xor(cmp, a.right, b.right),
      );
    }
    return nodeJoin(a.prefix, na, b.prefix, nb);
  },

  difference<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return null;
    if (nb === null) return na;
    if (na === nb) return null;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          const res = SetLinkedOps.difference(cmp, la, lb);
          if (res === null) return null;
          return new SetLeaf<K>(a.hash, res.key, res.setNext);
        }
        return na;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.difference(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.difference(cmp, na, b.right);
      return na;
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.difference(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.difference(cmp, a.right, nb));
      return na;
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.difference(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.difference(cmp, na, b.right);
      return na;
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, SetNodeOps.difference(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, SetNodeOps.difference(cmp, a.right, nb));
      return na;
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        SetNodeOps.difference(cmp, a.left, b.left),
        SetNodeOps.difference(cmp, a.right, b.right),
      );
    }
    return na;
  },

  overlaps<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): boolean {
    if (na === null || nb === null) return false;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          return SetLinkedOps.overlaps(cmp, la, lb);
        }
        return false;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.overlaps(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.overlaps(cmp, na, b.right);
      return false;
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.overlaps(cmp, a.left, nb);
      if (bit === 1) return SetNodeOps.overlaps(cmp, a.right, nb);
      return false;
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.overlaps(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.overlaps(cmp, na, b.right);
      return false;
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return SetNodeOps.overlaps(cmp, a.left, nb);
      if (bit === 1) return SetNodeOps.overlaps(cmp, a.right, nb);
      return false;
    }
    if (a.prefix === b.prefix) {
      return (
        SetNodeOps.overlaps(cmp, a.left, b.left) ||
        SetNodeOps.overlaps(cmp, a.right, b.right)
      );
    }
    return false;
  },

  subset<K>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): boolean {
    if (na === null) return true;
    if (nb === null) return false;
    if (na === nb) return true;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          return SetLinkedOps.subset(cmp, la, lb);
        }
        return false;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.subset(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.subset(cmp, na, b.right);
      return false;
    }
    if (nb.isLeaf) return false;
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return SetNodeOps.subset(cmp, na, b.left);
      if (bit === 1) return SetNodeOps.subset(cmp, na, b.right);
      return false;
    }
    if (cc < 0) return false;
    if (a.prefix === b.prefix) {
      return (
        SetNodeOps.subset(cmp, a.left, b.left) &&
        SetNodeOps.subset(cmp, a.right, b.right)
      );
    }
    return false;
  },

  /**
   * Computes a SetNode (actually MapLeaf-shaped, i.e. a delta map)
   * representing the per-key delta from `na` to `nb`.
   */
  computeDelta<K, OP>(
    cmp: IEqualityComparer<K>,
    onlyLeft: (k: K) => OP | undefined,
    onlyRight: (k: K) => OP | undefined,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return SetNodeOps.chooseToMapV(onlyRight, nb);
    if (nb === null) return SetNodeOps.chooseToMapV(onlyLeft, na);
    if (na === nb) return null;
    if (na.isLeaf) {
      const a = na as SetLeaf<K>;
      if (nb.isLeaf) {
        const b = nb as SetLeaf<K>;
        if (a.hash === b.hash) {
          const la = new SetLinked<K>(a.key, a.setNext);
          const lb = new SetLinked<K>(b.key, b.setNext);
          const ops = SetLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, la, lb);
          if (ops === null) return null;
          return new MapLeaf<K, OP>(a.hash, ops.key, ops.value, ops.mapNext);
        }
        const da = SetNodeOps.chooseToMapV(onlyLeft, na);
        const db = SetNodeOps.chooseToMapV(onlyRight, nb);
        return nodeJoin(a.hash, da, b.hash, db);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, na, b.left),
          SetNodeOps.chooseToMapV(onlyRight, b.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          SetNodeOps.chooseToMapV(onlyRight, b.left),
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, na, b.right),
        );
      }
      return nodeJoin(
        b.prefix,
        SetNodeOps.chooseToMapV(onlyRight, nb),
        a.hash,
        SetNodeOps.chooseToMapV(onlyLeft, na),
      );
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.left, nb),
          SetNodeOps.chooseToMapV(onlyLeft, a.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          SetNodeOps.chooseToMapV(onlyLeft, a.left),
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.right, nb),
        );
      }
      return nodeJoin(
        a.prefix,
        SetNodeOps.chooseToMapV(onlyLeft, na),
        b.hash,
        SetNodeOps.chooseToMapV(onlyRight, nb),
      );
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, na, b.left),
          SetNodeOps.chooseToMapV(onlyRight, b.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          SetNodeOps.chooseToMapV(onlyRight, b.left),
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, na, b.right),
        );
      }
      return nodeJoin(
        b.prefix,
        SetNodeOps.chooseToMapV(onlyRight, nb),
        a.prefix,
        SetNodeOps.chooseToMapV(onlyLeft, na),
      );
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.left, nb),
          SetNodeOps.chooseToMapV(onlyLeft, a.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          SetNodeOps.chooseToMapV(onlyLeft, a.left),
          SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.right, nb),
        );
      }
      return nodeJoin(
        a.prefix,
        SetNodeOps.chooseToMapV(onlyLeft, na),
        b.prefix,
        SetNodeOps.chooseToMapV(onlyRight, nb),
      );
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.left, b.left),
        SetNodeOps.computeDelta(cmp, onlyLeft, onlyRight, a.right, b.right),
      );
    }
    return nodeJoin(
      a.prefix,
      SetNodeOps.chooseToMapV(onlyLeft, na),
      b.prefix,
      SetNodeOps.chooseToMapV(onlyRight, nb),
    );
  },

  applyDeltaNoState<K, D, DOut>(
    apply: (k: K, existed: boolean, d: D) => [boolean, DOut | undefined],
    delta: SetNode<K> | null,
  ): [SetNode<K> | null, SetNode<K> | null] {
    if (delta === null) return [null, null];
    if (delta.isLeaf) {
      const d = delta as MapLeaf<K, D>;
      const [exists, op] = apply(d.key, false, d.value);
      const [rest, ls] = SetLinkedOps.applyDeltaNoState(apply, d.mapNext);
      let state: SetNode<K> | null;
      if (exists) state = new SetLeaf<K>(d.hash, d.key, ls);
      else if (ls === null) state = null;
      else state = new SetLeaf<K>(d.hash, ls.key, ls.setNext);
      if (op !== undefined) {
        return [new MapLeaf<K, DOut>(d.hash, d.key, op, rest), state];
      }
      if (rest === null) return [null, state];
      return [new MapLeaf<K, DOut>(d.hash, rest.key, rest.value, rest.mapNext), state];
    }
    const inner = delta as Inner<K>;
    const [l, ls] = SetNodeOps.applyDeltaNoState(apply, inner.left);
    const [r, rs] = SetNodeOps.applyDeltaNoState(apply, inner.right);
    return [
      nodeNewInner(inner.prefix, inner.mask, l, r),
      nodeNewInner(inner.prefix, inner.mask, ls, rs),
    ];
  },

  hash<K>(acc: number, node: SetNode<K> | null): number {
    if (node === null) return acc;
    if (node.isLeaf) {
      const leaf = node as SetLeaf<K>;
      let cnt = 1;
      let cur = leaf.setNext;
      while (cur !== null) {
        cnt += 1;
        cur = cur.setNext;
      }
      return combineHash(acc, combineHash(leaf.hash, cnt));
    }
    const inner = node as Inner<K>;
    const lh = SetNodeOps.hash(acc, inner.left);
    const nh = combineHash(lh, combineHash(inner.prefix, inner.mask));
    return SetNodeOps.hash(nh, inner.right);
  },

  applyDelta<K, D, DOut>(
    cmp: IEqualityComparer<K>,
    apply: (k: K, existed: boolean, d: D) => [boolean, DOut | undefined],
    state: SetNode<K> | null,
    delta: SetNode<K> | null,
  ): [SetNode<K> | null, SetNode<K> | null] {
    if (delta === null) return [null, state];
    if (state === null) return SetNodeOps.applyDeltaNoState(apply, delta);
    if (delta.isLeaf) {
      const d = delta as MapLeaf<K, D>;
      if (state.isLeaf) {
        const s = state as SetLeaf<K>;
        if (s.hash === d.hash) {
          const lstate = new SetLinked<K>(s.key, s.setNext);
          const ldelta = new MapLinked<K, D>(d.key, d.value, d.mapNext);
          const [ld, ls] = SetLinkedOps.applyDelta(cmp, apply, ldelta, lstate);
          const newState = ls === null ? null : new SetLeaf<K>(s.hash, ls.key, ls.setNext);
          if (ld === null) return [null, newState];
          return [new MapLeaf<K, DOut>(d.hash, ld.key, ld.value, ld.mapNext), newState];
        }
        const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
        return [ld, nodeJoin(s.hash, s, d.hash, ls)];
      }
      const s = state as Inner<K>;
      const bit = matchPrefixAndGetBit(d.hash, s.prefix, s.mask);
      if (bit === 0) {
        const [del, l] = SetNodeOps.applyDelta(cmp, apply, s.left, delta);
        return [del, nodeNewInner(s.prefix, s.mask, l, s.right)];
      }
      if (bit === 1) {
        const [del, r] = SetNodeOps.applyDelta(cmp, apply, s.right, delta);
        return [del, nodeNewInner(s.prefix, s.mask, s.left, r)];
      }
      const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
      return [ld, nodeJoin(s.prefix, s, d.hash, ls)];
    }
    if (state.isLeaf) {
      const s = state as SetLeaf<K>;
      const d = delta as Inner<K>;
      const bit = matchPrefixAndGetBit(s.hash, d.prefix, d.mask);
      if (bit === 0) {
        const [ld, ls] = SetNodeOps.applyDelta(cmp, apply, state, d.left);
        const [rd, rs] = SetNodeOps.applyDelta(cmp, apply, null, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      if (bit === 1) {
        const [ld, ls] = SetNodeOps.applyDelta(cmp, apply, null, d.left);
        const [rd, rs] = SetNodeOps.applyDelta(cmp, apply, state, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
      return [ld, nodeJoin(s.hash, state, d.prefix, ls)];
    }
    const d = delta as Inner<K>;
    const s = state as Inner<K>;
    const cc = compareMasks(d.mask, s.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(d.prefix, s.prefix, s.mask);
      if (bit === 0) {
        const [del, l] = SetNodeOps.applyDelta(cmp, apply, s.left, delta);
        return [del, nodeNewInner(s.prefix, s.mask, l, s.right)];
      }
      if (bit === 1) {
        const [del, r] = SetNodeOps.applyDelta(cmp, apply, s.right, delta);
        return [del, nodeNewInner(s.prefix, s.mask, s.left, r)];
      }
      const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
      return [ld, nodeJoin(s.prefix, s, d.prefix, ls)];
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(s.prefix, d.prefix, d.mask);
      if (bit === 0) {
        const [ld, ls] = SetNodeOps.applyDelta(cmp, apply, state, d.left);
        const [rd, rs] = SetNodeOps.applyDelta(cmp, apply, null, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      if (bit === 1) {
        const [ld, ls] = SetNodeOps.applyDelta(cmp, apply, null, d.left);
        const [rd, rs] = SetNodeOps.applyDelta(cmp, apply, state, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
      return [ld, nodeJoin(s.prefix, state, d.prefix, ls)];
    }
    if (s.prefix === d.prefix) {
      const [ld, ls] = SetNodeOps.applyDelta(cmp, apply, s.left, d.left);
      const [rd, rs] = SetNodeOps.applyDelta(cmp, apply, s.right, d.right);
      return [
        nodeNewInner(d.prefix, d.mask, ld, rd),
        nodeNewInner(s.prefix, s.mask, ls, rs),
      ];
    }
    const [ld, ls] = SetNodeOps.applyDeltaNoState(apply, delta);
    return [ld, nodeJoin(s.prefix, state, d.prefix, ls)];
  },
};

// ---------------------------------------------------------------------------
// MapNode operations (HAMT for maps; reuses SetNode helpers)
// ---------------------------------------------------------------------------

const MapNodeOps = {
  add<K, V>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    value: V,
    node: SetNode<K> | null,
  ): SetNode<K> {
    if (node === null) return new MapLeaf<K, V>(hash, key, value, null);
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (leaf.hash === hash) {
        if (cmp.equals(leaf.key, key)) {
          return new MapLeaf<K, V>(leaf.hash, key, value, leaf.mapNext);
        }
        return new MapLeaf<K, V>(
          leaf.hash,
          leaf.key,
          leaf.value,
          MapLinkedOps.add(cmp, key, value, leaf.mapNext),
        );
      }
      return nodeJoin(leaf.hash, leaf, hash, new MapLeaf<K, V>(hash, key, value, null))!;
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        MapNodeOps.add(cmp, hash, key, value, inner.left),
        inner.right,
      )!;
    }
    if (bit === 1) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        inner.left,
        MapNodeOps.add(cmp, hash, key, value, inner.right),
      )!;
    }
    return nodeJoin(inner.prefix, inner, hash, new MapLeaf<K, V>(hash, key, value, null))!;
  },

  alter<K, V>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    update: (existing: V | undefined) => V | undefined,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) {
      const v = update(undefined);
      if (v === undefined) return null;
      return new MapLeaf<K, V>(hash, key, v, null);
    }
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (leaf.hash === hash) {
        if (cmp.equals(leaf.key, key)) {
          const v = update(leaf.value);
          if (v === undefined) {
            const next = leaf.mapNext;
            if (next === null) return null;
            return new MapLeaf<K, V>(leaf.hash, next.key, next.value, next.mapNext);
          }
          return new MapLeaf<K, V>(leaf.hash, key, v, leaf.mapNext);
        }
        return new MapLeaf<K, V>(
          leaf.hash,
          leaf.key,
          leaf.value,
          MapLinkedOps.alter(cmp, key, update, leaf.mapNext),
        );
      }
      const v = update(undefined);
      if (v === undefined) return leaf;
      return nodeJoin(leaf.hash, leaf, hash, new MapLeaf<K, V>(hash, key, v, null));
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        MapNodeOps.alter(cmp, hash, key, update, inner.left),
        inner.right,
      );
    }
    if (bit === 1) {
      return nodeNewInner(
        inner.prefix,
        inner.mask,
        inner.left,
        MapNodeOps.alter(cmp, hash, key, update, inner.right),
      );
    }
    const v = update(undefined);
    if (v === undefined) return inner;
    return nodeJoin(inner.prefix, inner, hash, new MapLeaf<K, V>(hash, key, v, null));
  },

  tryRemove<K, V>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): [V | undefined, SetNode<K> | null] {
    if (node === null) return [undefined, null];
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (leaf.hash !== hash) return [undefined, leaf];
      if (cmp.equals(leaf.key, key)) {
        const next = leaf.mapNext;
        if (next === null) return [leaf.value, null];
        return [leaf.value, new MapLeaf<K, V>(leaf.hash, next.key, next.value, next.mapNext)];
      }
      const [v, next] = MapLinkedOps.tryRemove(cmp, key, leaf.mapNext);
      if (v === undefined) return [undefined, leaf];
      return [v, new MapLeaf<K, V>(leaf.hash, leaf.key, leaf.value, next)];
    }
    const inner = node as Inner<K>;
    const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
    if (bit === 0) {
      const [v, l] = MapNodeOps.tryRemove<K, V>(cmp, hash, key, inner.left);
      if (v === undefined) return [undefined, inner];
      return [v, nodeNewInner(inner.prefix, inner.mask, l, inner.right)];
    }
    if (bit === 1) {
      const [v, r] = MapNodeOps.tryRemove<K, V>(cmp, hash, key, inner.right);
      if (v === undefined) return [undefined, inner];
      return [v, nodeNewInner(inner.prefix, inner.mask, inner.left, r)];
    }
    return [undefined, inner];
  },

  tryFind<K, V>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): V | undefined {
    let cur = node;
    while (cur !== null) {
      if (cur.isLeaf) {
        const leaf = cur as MapLeaf<K, V>;
        if (leaf.hash !== hash) return undefined;
        if (cmp.equals(leaf.key, key)) return leaf.value;
        return MapLinkedOps.tryFind(cmp, key, leaf.mapNext);
      }
      const inner = cur as Inner<K>;
      const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
      if (bit === 0) cur = inner.left;
      else if (bit === 1) cur = inner.right;
      else return undefined;
    }
    return undefined;
  },

  containsKey<K, V>(
    cmp: IEqualityComparer<K>,
    hash: number,
    key: K,
    node: SetNode<K> | null,
  ): boolean {
    let cur = node;
    while (cur !== null) {
      if (cur.isLeaf) {
        const leaf = cur as MapLeaf<K, V>;
        if (leaf.hash !== hash) return false;
        if (cmp.equals(leaf.key, key)) return true;
        return MapLinkedOps.containsKey(cmp, key, leaf.mapNext);
      }
      const inner = cur as Inner<K>;
      const bit = matchPrefixAndGetBit(hash, inner.prefix, inner.mask);
      if (bit === 0) cur = inner.left;
      else if (bit === 1) cur = inner.right;
      else return false;
    }
    return false;
  },

  toList<K, V>(acc: Array<[K, V]>, node: SetNode<K> | null): Array<[K, V]> {
    if (node === null) return acc;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      acc.push([leaf.key, leaf.value]);
      return MapLinkedOps.toList(acc, leaf.mapNext);
    }
    const inner = node as Inner<K>;
    const left = MapNodeOps.toList(acc, inner.left);
    return MapNodeOps.toList(left, inner.right);
  },

  toValueList<K, V>(acc: V[], node: SetNode<K> | null): V[] {
    if (node === null) return acc;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      acc.push(leaf.value);
      return MapLinkedOps.toValueList(acc, leaf.mapNext);
    }
    const inner = node as Inner<K>;
    const left = MapNodeOps.toValueList(acc, inner.left);
    return MapNodeOps.toValueList(left, inner.right);
  },

  iter<K, V>(action: (k: K, v: V) => void, node: SetNode<K> | null): void {
    if (node === null) return;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      action(leaf.key, leaf.value);
      let cur = leaf.mapNext;
      while (cur !== null) {
        action(cur.key, cur.value);
        cur = cur.mapNext;
      }
      return;
    }
    const inner = node as Inner<K>;
    MapNodeOps.iter(action, inner.left);
    MapNodeOps.iter(action, inner.right);
  },

  fold<K, V, S>(
    folder: (s: S, k: K, v: V) => S,
    state: S,
    node: SetNode<K> | null,
  ): S {
    if (node === null) return state;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      let s = folder(state, leaf.key, leaf.value);
      let cur = leaf.mapNext;
      while (cur !== null) {
        s = folder(s, cur.key, cur.value);
        cur = cur.mapNext;
      }
      return s;
    }
    const inner = node as Inner<K>;
    const s = MapNodeOps.fold(folder, state, inner.left);
    return MapNodeOps.fold(folder, s, inner.right);
  },

  exists<K, V>(predicate: (k: K, v: V) => boolean, node: SetNode<K> | null): boolean {
    if (node === null) return false;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (predicate(leaf.key, leaf.value)) return true;
      return MapLinkedOps.exists(predicate, leaf.mapNext);
    }
    const inner = node as Inner<K>;
    return (
      MapNodeOps.exists(predicate, inner.left) ||
      MapNodeOps.exists(predicate, inner.right)
    );
  },

  forall<K, V>(predicate: (k: K, v: V) => boolean, node: SetNode<K> | null): boolean {
    if (node === null) return true;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (!predicate(leaf.key, leaf.value)) return false;
      return MapLinkedOps.forall(predicate, leaf.mapNext);
    }
    const inner = node as Inner<K>;
    return (
      MapNodeOps.forall(predicate, inner.left) &&
      MapNodeOps.forall(predicate, inner.right)
    );
  },

  map<K, V, T>(
    mapping: (k: K, v: V) => T,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      return new MapLeaf<K, T>(
        leaf.hash,
        leaf.key,
        mapping(leaf.key, leaf.value),
        MapLinkedOps.map(mapping, leaf.mapNext),
      );
    }
    const inner = node as Inner<K>;
    return new Inner<K>(
      inner.prefix,
      inner.mask,
      MapNodeOps.map(mapping, inner.left),
      MapNodeOps.map(mapping, inner.right),
    );
  },

  filter<K, V>(
    predicate: (k: K, v: V) => boolean,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      if (predicate(leaf.key, leaf.value)) {
        return new MapLeaf<K, V>(
          leaf.hash,
          leaf.key,
          leaf.value,
          MapLinkedOps.filter(predicate, leaf.mapNext),
        );
      }
      const l = MapLinkedOps.filter(predicate, leaf.mapNext);
      if (l === null) return null;
      return new MapLeaf<K, V>(leaf.hash, l.key, l.value, l.mapNext);
    }
    const inner = node as Inner<K>;
    return nodeNewInner(
      inner.prefix,
      inner.mask,
      MapNodeOps.filter(predicate, inner.left),
      MapNodeOps.filter(predicate, inner.right),
    );
  },

  choose<K, V, T>(
    mapping: (k: K, v: V) => T | undefined,
    node: SetNode<K> | null,
  ): SetNode<K> | null {
    if (node === null) return null;
    if (node.isLeaf) {
      const leaf = node as MapLeaf<K, V>;
      const v = mapping(leaf.key, leaf.value);
      if (v !== undefined) {
        return new MapLeaf<K, T>(
          leaf.hash,
          leaf.key,
          v,
          MapLinkedOps.choose(mapping, leaf.mapNext),
        );
      }
      const next = MapLinkedOps.choose(mapping, leaf.mapNext);
      if (next === null) return null;
      return new MapLeaf<K, T>(leaf.hash, next.key, next.value, next.mapNext);
    }
    const inner = node as Inner<K>;
    return nodeNewInner(
      inner.prefix,
      inner.mask,
      MapNodeOps.choose(mapping, inner.left),
      MapNodeOps.choose(mapping, inner.right),
    );
  },

  equals<K, V>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): boolean {
    if (na === null) return nb === null;
    if (nb === null) return false;
    if (na === nb) return true;
    if (na.isLeaf) {
      if (!nb.isLeaf) return false;
      const a = na as MapLeaf<K, V>;
      const b = nb as MapLeaf<K, V>;
      if (a.hash !== b.hash) return false;
      const la = new MapLinked<K, V>(a.key, a.value, a.mapNext);
      const lb = new MapLinked<K, V>(b.key, b.value, b.mapNext);
      return MapLinkedOps.equals(cmp, la, lb);
    }
    if (nb.isLeaf) return false;
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    if (a.prefix !== b.prefix || a.mask !== b.mask) return false;
    return (
      MapNodeOps.equals(cmp, a.left, b.left) &&
      MapNodeOps.equals(cmp, a.right, b.right)
    );
  },

  union<K, V>(
    cmp: IEqualityComparer<K>,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return nb;
    if (nb === null) return na;
    if (na === nb) return na;
    if (na.isLeaf) {
      const a = na as MapLeaf<K, V>;
      if (nb.isLeaf) {
        const b = nb as MapLeaf<K, V>;
        if (a.hash === b.hash) {
          const la = new MapLinked<K, V>(a.key, a.value, a.mapNext);
          const lb = new MapLinked<K, V>(b.key, b.value, b.mapNext);
          const res = MapLinkedOps.union(cmp, la, lb);
          if (res === null) return null;
          return new MapLeaf<K, V>(a.hash, res.key, res.value, res.mapNext);
        }
        return nodeJoin(a.hash, na, b.hash, nb);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, MapNodeOps.union<K, V>(cmp, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, MapNodeOps.union<K, V>(cmp, na, b.right));
      return nodeJoin(a.hash, na, b.prefix, nb);
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as MapLeaf<K, V>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, MapNodeOps.union<K, V>(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, MapNodeOps.union<K, V>(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.hash, nb);
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, MapNodeOps.union<K, V>(cmp, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, MapNodeOps.union<K, V>(cmp, na, b.right));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, MapNodeOps.union<K, V>(cmp, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, MapNodeOps.union<K, V>(cmp, a.right, nb));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        MapNodeOps.union<K, V>(cmp, a.left, b.left),
        MapNodeOps.union<K, V>(cmp, a.right, b.right),
      );
    }
    return nodeJoin(a.prefix, na, b.prefix, nb);
  },

  unionWith<K, V>(
    cmp: IEqualityComparer<K>,
    resolve: (k: K, l: V, r: V) => V,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return nb;
    if (nb === null) return na;
    if (na.isLeaf) {
      const a = na as MapLeaf<K, V>;
      if (nb.isLeaf) {
        const b = nb as MapLeaf<K, V>;
        if (a.hash === b.hash) {
          const la = new MapLinked<K, V>(a.key, a.value, a.mapNext);
          const lb = new MapLinked<K, V>(b.key, b.value, b.mapNext);
          const res = MapLinkedOps.unionWith(cmp, resolve, la, lb);
          if (res === null) return null;
          return new MapLeaf<K, V>(a.hash, res.key, res.value, res.mapNext);
        }
        return nodeJoin(a.hash, na, b.hash, nb);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, MapNodeOps.unionWith(cmp, resolve, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, MapNodeOps.unionWith(cmp, resolve, na, b.right));
      return nodeJoin(a.hash, na, b.prefix, nb);
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as MapLeaf<K, V>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, MapNodeOps.unionWith(cmp, resolve, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, MapNodeOps.unionWith(cmp, resolve, a.right, nb));
      return nodeJoin(a.prefix, na, b.hash, nb);
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return nodeNewInner(b.prefix, b.mask, MapNodeOps.unionWith(cmp, resolve, na, b.left), b.right);
      if (bit === 1) return nodeNewInner(b.prefix, b.mask, b.left, MapNodeOps.unionWith(cmp, resolve, na, b.right));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return nodeNewInner(a.prefix, a.mask, MapNodeOps.unionWith(cmp, resolve, a.left, nb), a.right);
      if (bit === 1) return nodeNewInner(a.prefix, a.mask, a.left, MapNodeOps.unionWith(cmp, resolve, a.right, nb));
      return nodeJoin(a.prefix, na, b.prefix, nb);
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        MapNodeOps.unionWith(cmp, resolve, a.left, b.left),
        MapNodeOps.unionWith(cmp, resolve, a.right, b.right),
      );
    }
    return nodeJoin(a.prefix, na, b.prefix, nb);
  },

  intersect<K, A, B, C>(
    cmp: IEqualityComparer<K>,
    resolve: (k: K, a: A, b: B) => C,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null || nb === null) return null;
    if (na.isLeaf) {
      const a = na as MapLeaf<K, A>;
      if (nb.isLeaf) {
        const b = nb as MapLeaf<K, B>;
        if (a.hash === b.hash) {
          const la = new MapLinked<K, A>(a.key, a.value, a.mapNext);
          const lb = new MapLinked<K, B>(b.key, b.value, b.mapNext);
          const res = MapLinkedOps.intersect(cmp, resolve, la, lb);
          if (res === null) return null;
          return new MapLeaf<K, C>(a.hash, res.key, res.value, res.mapNext);
        }
        return null;
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) return MapNodeOps.intersect(cmp, resolve, na, b.left);
      if (bit === 1) return MapNodeOps.intersect(cmp, resolve, na, b.right);
      return null;
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as SetLeaf<K>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) return MapNodeOps.intersect(cmp, resolve, a.left, nb);
      if (bit === 1) return MapNodeOps.intersect(cmp, resolve, a.right, nb);
      return null;
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) return MapNodeOps.intersect(cmp, resolve, na, b.left);
      if (bit === 1) return MapNodeOps.intersect(cmp, resolve, na, b.right);
      return null;
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) return MapNodeOps.intersect(cmp, resolve, a.left, nb);
      if (bit === 1) return MapNodeOps.intersect(cmp, resolve, a.right, nb);
      return null;
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        MapNodeOps.intersect(cmp, resolve, a.left, b.left),
        MapNodeOps.intersect(cmp, resolve, a.right, b.right),
      );
    }
    return null;
  },

  computeDelta<K, V, OP>(
    cmp: IEqualityComparer<K>,
    onlyLeft: (k: K, v: V) => OP | undefined,
    onlyRight: (k: K, v: V) => OP | undefined,
    both: (k: K, l: V, r: V) => OP | undefined,
    na: SetNode<K> | null,
    nb: SetNode<K> | null,
  ): SetNode<K> | null {
    if (na === null) return MapNodeOps.choose(onlyRight, nb);
    if (nb === null) return MapNodeOps.choose(onlyLeft, na);
    if (na === nb) return null;
    if (na.isLeaf) {
      const a = na as MapLeaf<K, V>;
      if (nb.isLeaf) {
        const b = nb as MapLeaf<K, V>;
        if (a.hash === b.hash) {
          const la = new MapLinked<K, V>(a.key, a.value, a.mapNext);
          const lb = new MapLinked<K, V>(b.key, b.value, b.mapNext);
          const delta = MapLinkedOps.computeDelta(cmp, onlyLeft, onlyRight, both, la, lb);
          if (delta === null) return null;
          return new MapLeaf<K, OP>(a.hash, delta.key, delta.value, delta.mapNext);
        }
        const da = MapNodeOps.choose(onlyLeft, na);
        const db = MapNodeOps.choose(onlyRight, nb);
        return nodeJoin(a.hash, da, b.hash, db);
      }
      const b = nb as Inner<K>;
      const bit = matchPrefixAndGetBit(a.hash, b.prefix, b.mask);
      if (bit === 0) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, na, b.left),
          MapNodeOps.choose(onlyRight, b.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          MapNodeOps.choose(onlyRight, b.left),
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, na, b.right),
        );
      }
      return nodeJoin(
        a.hash,
        MapNodeOps.choose(onlyLeft, na),
        b.prefix,
        MapNodeOps.choose(onlyRight, nb),
      );
    }
    if (nb.isLeaf) {
      const a = na as Inner<K>;
      const b = nb as MapLeaf<K, V>;
      const bit = matchPrefixAndGetBit(b.hash, a.prefix, a.mask);
      if (bit === 0) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.left, nb),
          MapNodeOps.choose(onlyLeft, a.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          MapNodeOps.choose(onlyLeft, a.left),
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.right, nb),
        );
      }
      return nodeJoin(
        a.prefix,
        MapNodeOps.choose(onlyLeft, na),
        b.hash,
        MapNodeOps.choose(onlyRight, nb),
      );
    }
    const a = na as Inner<K>;
    const b = nb as Inner<K>;
    const cc = compareMasks(a.mask, b.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(a.prefix, b.prefix, b.mask);
      if (bit === 0) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, na, b.left),
          MapNodeOps.choose(onlyRight, b.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          b.prefix,
          b.mask,
          MapNodeOps.choose(onlyRight, b.left),
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, na, b.right),
        );
      }
      return nodeJoin(
        a.prefix,
        MapNodeOps.choose(onlyLeft, na),
        b.prefix,
        MapNodeOps.choose(onlyRight, nb),
      );
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(b.prefix, a.prefix, a.mask);
      if (bit === 0) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.left, nb),
          MapNodeOps.choose(onlyLeft, a.right),
        );
      }
      if (bit === 1) {
        return nodeNewInner(
          a.prefix,
          a.mask,
          MapNodeOps.choose(onlyLeft, a.left),
          MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.right, nb),
        );
      }
      return nodeJoin(
        a.prefix,
        MapNodeOps.choose(onlyLeft, na),
        b.prefix,
        MapNodeOps.choose(onlyRight, nb),
      );
    }
    if (a.prefix === b.prefix) {
      return nodeNewInner(
        a.prefix,
        a.mask,
        MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.left, b.left),
        MapNodeOps.computeDelta(cmp, onlyLeft, onlyRight, both, a.right, b.right),
      );
    }
    return nodeJoin(
      a.prefix,
      MapNodeOps.choose(onlyLeft, na),
      b.prefix,
      MapNodeOps.choose(onlyRight, nb),
    );
  },

  applyDeltaNoState<K, V, D, DOut>(
    apply: (k: K, existing: V | undefined, d: D) => [V | undefined, DOut | undefined],
    delta: SetNode<K> | null,
  ): [SetNode<K> | null, SetNode<K> | null] {
    if (delta === null) return [null, null];
    if (delta.isLeaf) {
      const d = delta as MapLeaf<K, D>;
      const [newValue, op] = apply(d.key, undefined, d.value);
      const [rest, ls] = MapLinkedOps.applyDeltaNoState<K, V, D, DOut>(apply, d.mapNext);
      let state: SetNode<K> | null;
      if (newValue !== undefined) state = new MapLeaf<K, V>(d.hash, d.key, newValue, ls);
      else if (ls === null) state = null;
      else state = new MapLeaf<K, V>(d.hash, ls.key, ls.value, ls.mapNext);
      if (op !== undefined) {
        return [new MapLeaf<K, DOut>(d.hash, d.key, op, rest), state];
      }
      if (rest === null) return [null, state];
      return [new MapLeaf<K, DOut>(d.hash, rest.key, rest.value, rest.mapNext), state];
    }
    const inner = delta as Inner<K>;
    const [l, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, inner.left);
    const [r, rs] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, inner.right);
    return [
      nodeNewInner(inner.prefix, inner.mask, l, r),
      nodeNewInner(inner.prefix, inner.mask, ls, rs),
    ];
  },

  applyDelta<K, V, D, DOut>(
    cmp: IEqualityComparer<K>,
    apply: (k: K, existing: V | undefined, d: D) => [V | undefined, DOut | undefined],
    state: SetNode<K> | null,
    delta: SetNode<K> | null,
  ): [SetNode<K> | null, SetNode<K> | null] {
    if (delta === null) return [null, state];
    if (state === null) return MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
    if (delta.isLeaf) {
      const d = delta as MapLeaf<K, D>;
      if (state.isLeaf) {
        const s = state as MapLeaf<K, V>;
        if (s.hash === d.hash) {
          const lstate = new MapLinked<K, V>(s.key, s.value, s.mapNext);
          const ldelta = new MapLinked<K, D>(d.key, d.value, d.mapNext);
          const [ld, ls] = MapLinkedOps.applyDelta(cmp, apply, ldelta, lstate);
          const newState = ls === null ? null : new MapLeaf<K, V>(s.hash, ls.key, ls.value, ls.mapNext);
          if (ld === null) return [null, newState];
          return [new MapLeaf<K, DOut>(d.hash, ld.key, ld.value, ld.mapNext), newState];
        }
        const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
        return [ld, nodeJoin(s.hash, s, d.hash, ls)];
      }
      const s = state as Inner<K>;
      const bit = matchPrefixAndGetBit(d.hash, s.prefix, s.mask);
      if (bit === 0) {
        const [del, l] = MapNodeOps.applyDelta(cmp, apply, s.left, delta);
        return [del, nodeNewInner(s.prefix, s.mask, l, s.right)];
      }
      if (bit === 1) {
        const [del, r] = MapNodeOps.applyDelta(cmp, apply, s.right, delta);
        return [del, nodeNewInner(s.prefix, s.mask, s.left, r)];
      }
      const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
      return [ld, nodeJoin(s.prefix, s, d.hash, ls)];
    }
    if (state.isLeaf) {
      const s = state as MapLeaf<K, V>;
      const d = delta as Inner<K>;
      const bit = matchPrefixAndGetBit(s.hash, d.prefix, d.mask);
      if (bit === 0) {
        const [ld, ls] = MapNodeOps.applyDelta(cmp, apply, state, d.left);
        const [rd, rs] = MapNodeOps.applyDelta(cmp, apply, null, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      if (bit === 1) {
        const [ld, ls] = MapNodeOps.applyDelta(cmp, apply, null, d.left);
        const [rd, rs] = MapNodeOps.applyDelta(cmp, apply, state, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
      return [ld, nodeJoin(s.hash, state, d.prefix, ls)];
    }
    const d = delta as Inner<K>;
    const s = state as Inner<K>;
    const cc = compareMasks(d.mask, s.mask);
    if (cc > 0) {
      const bit = matchPrefixAndGetBit(d.prefix, s.prefix, s.mask);
      if (bit === 0) {
        const [del, l] = MapNodeOps.applyDelta(cmp, apply, s.left, delta);
        return [del, nodeNewInner(s.prefix, s.mask, l, s.right)];
      }
      if (bit === 1) {
        const [del, r] = MapNodeOps.applyDelta(cmp, apply, s.right, delta);
        return [del, nodeNewInner(s.prefix, s.mask, s.left, r)];
      }
      const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
      return [ld, nodeJoin(s.prefix, s, d.prefix, ls)];
    }
    if (cc < 0) {
      const bit = matchPrefixAndGetBit(s.prefix, d.prefix, d.mask);
      if (bit === 0) {
        const [ld, ls] = MapNodeOps.applyDelta(cmp, apply, state, d.left);
        const [rd, rs] = MapNodeOps.applyDelta(cmp, apply, null, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      if (bit === 1) {
        const [ld, ls] = MapNodeOps.applyDelta(cmp, apply, null, d.left);
        const [rd, rs] = MapNodeOps.applyDelta(cmp, apply, state, d.right);
        return [
          nodeNewInner(d.prefix, d.mask, ld, rd),
          nodeNewInner(d.prefix, d.mask, ls, rs),
        ];
      }
      const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
      return [ld, nodeJoin(s.prefix, state, d.prefix, ls)];
    }
    if (s.prefix === d.prefix) {
      const [ld, ls] = MapNodeOps.applyDelta(cmp, apply, s.left, d.left);
      const [rd, rs] = MapNodeOps.applyDelta(cmp, apply, s.right, d.right);
      return [
        nodeNewInner(d.prefix, d.mask, ld, rd),
        nodeNewInner(s.prefix, s.mask, ls, rs),
      ];
    }
    const [ld, ls] = MapNodeOps.applyDeltaNoState<K, V, D, DOut>(apply, delta);
    return [ld, nodeJoin(s.prefix, state, d.prefix, ls)];
  },
};

// ---------------------------------------------------------------------------
// Public HashSet<K>
// ---------------------------------------------------------------------------

function hashKey<K>(cmp: IEqualityComparer<K>, key: K): number {
  return (cmp.hash(key) & 0x7fffffff) >>> 0;
}

export class HashSet<K> implements Iterable<K> {
  /** @internal */
  readonly _cmp: IEqualityComparer<K>;
  /** @internal */
  readonly _root: SetNode<K> | null;

  /** @internal */
  constructor(cmp: IEqualityComparer<K>, root: SetNode<K> | null) {
    this._cmp = cmp;
    this._root = root;
  }

  get count(): number {
    return size(this._root);
  }
  get isEmpty(): boolean {
    return this._root === null;
  }

  contains(key: K): boolean {
    if (this._root === null) return false;
    return SetNodeOps.contains(this._cmp, hashKey(this._cmp, key), key, this._root);
  }

  add(key: K): HashSet<K> {
    return new HashSet<K>(
      this._cmp,
      SetNodeOps.add(this._cmp, hashKey(this._cmp, key), key, this._root),
    );
  }

  remove(key: K): HashSet<K> {
    const [ok, root] = SetNodeOps.tryRemove(
      this._cmp,
      hashKey(this._cmp, key),
      key,
      this._root,
    );
    if (ok) return new HashSet<K>(this._cmp, root);
    return this;
  }

  tryRemove(key: K): HashSet<K> | undefined {
    const [ok, root] = SetNodeOps.tryRemove(
      this._cmp,
      hashKey(this._cmp, key),
      key,
      this._root,
    );
    if (ok) return new HashSet<K>(this._cmp, root);
    return undefined;
  }

  alter(key: K, update: (existed: boolean) => boolean): HashSet<K> {
    return new HashSet<K>(
      this._cmp,
      SetNodeOps.alter(this._cmp, hashKey(this._cmp, key), key, update, this._root),
    );
  }

  iter(action: (k: K) => void): void {
    SetNodeOps.iter(action, this._root);
  }
  fold<S>(folder: (s: S, k: K) => S, state: S): S {
    return SetNodeOps.fold(folder, state, this._root);
  }
  exists(predicate: (k: K) => boolean): boolean {
    return SetNodeOps.exists(predicate, this._root);
  }
  forall(predicate: (k: K) => boolean): boolean {
    return SetNodeOps.forall(predicate, this._root);
  }

  map<U>(mapping: (k: K) => U): HashSet<U> {
    let out = HashSet.empty<U>();
    SetNodeOps.iter((k: K) => {
      out = out.add(mapping(k));
    }, this._root);
    return out;
  }

  choose<U>(mapping: (k: K) => U | undefined): HashSet<U> {
    let out = HashSet.empty<U>();
    SetNodeOps.iter((k: K) => {
      const u = mapping(k);
      if (u !== undefined) out = out.add(u);
    }, this._root);
    return out;
  }

  filter(predicate: (k: K) => boolean): HashSet<K> {
    return new HashSet<K>(this._cmp, SetNodeOps.filter(predicate, this._root));
  }

  first(): K {
    return SetNodeOps.head(this._root);
  }

  toList(): K[] {
    return SetNodeOps.toList<K>([], this._root);
  }
  toArray(): K[] {
    return this.toList();
  }

  *[Symbol.iterator](): IterableIterator<K> {
    const stack: Array<SetNode<K> | null> = [this._root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === null) continue;
      if (node.isLeaf) {
        const leaf = node as SetLeaf<K>;
        yield leaf.key;
        let cur = leaf.setNext;
        while (cur !== null) {
          yield cur.key;
          cur = cur.setNext;
        }
      } else {
        const inner = node as Inner<K>;
        stack.push(inner.right);
        stack.push(inner.left);
      }
    }
  }

  /** Structural hash — order-independent, matches `setEquals`. */
  getHash(): number {
    return SetNodeOps.hash(0, this._root);
  }

  setEquals(other: HashSet<K>): boolean {
    if (this.count !== other.count) return false;
    return SetNodeOps.equals(this._cmp, this._root, other._root);
  }
  overlaps(other: HashSet<K>): boolean {
    return SetNodeOps.overlaps(this._cmp, this._root, other._root);
  }
  isSubsetOf(other: HashSet<K>): boolean {
    return SetNodeOps.subset(this._cmp, this._root, other._root);
  }
  isSupersetOf(other: HashSet<K>): boolean {
    return other.isSubsetOf(this);
  }
  isProperSubsetOf(other: HashSet<K>): boolean {
    return this.count < other.count && this.isSubsetOf(other);
  }
  isProperSupersetOf(other: HashSet<K>): boolean {
    return this.count > other.count && this.isSupersetOf(other);
  }

  unionWith(other: HashSet<K>): HashSet<K> {
    return new HashSet<K>(this._cmp, SetNodeOps.union(this._cmp, this._root, other._root));
  }
  symmetricExceptWith(other: HashSet<K>): HashSet<K> {
    return new HashSet<K>(this._cmp, SetNodeOps.xor(this._cmp, this._root, other._root));
  }
  exceptWith(other: HashSet<K>): HashSet<K> {
    return new HashSet<K>(this._cmp, SetNodeOps.difference(this._cmp, this._root, other._root));
  }
  intersectWith(other: HashSet<K>): HashSet<K> {
    return new HashSet<K>(this._cmp, SetNodeOps.intersect(this._cmp, this._root, other._root));
  }
  intersectionCount(other: HashSet<K>): number {
    return SetNodeOps.intersectionCount(this._cmp, 0, this._root, other._root);
  }

  computeDeltaAsHashMap<OP>(
    other: HashSet<K>,
    onlyLeft: (k: K) => OP | undefined,
    onlyRight: (k: K) => OP | undefined,
  ): HashMap<K, OP> {
    return new HashMap<K, OP>(
      this._cmp,
      SetNodeOps.computeDelta(this._cmp, onlyLeft, onlyRight, this._root, other._root),
    );
  }

  computeDeltaAsHashMapStd(other: HashSet<K>): HashMap<K, number> {
    return this.computeDeltaAsHashMap<number>(
      other,
      () => -1,
      () => 1,
    );
  }

  static empty<K>(cmp?: IEqualityComparer<K>): HashSet<K> {
    return new HashSet<K>(cmp ?? comparerFor<K>(), null);
  }
  static single<K>(key: K, cmp?: IEqualityComparer<K>): HashSet<K> {
    return HashSet.empty<K>(cmp).add(key);
  }
  static ofSeq<K>(elements: Iterable<K>, cmp?: IEqualityComparer<K>): HashSet<K> {
    let s = HashSet.empty<K>(cmp);
    for (const k of elements) s = s.add(k);
    return s;
  }
  static ofArray<K>(elements: K[], cmp?: IEqualityComparer<K>): HashSet<K> {
    return HashSet.ofSeq(elements, cmp);
  }
  static ofList<K>(elements: K[], cmp?: IEqualityComparer<K>): HashSet<K> {
    return HashSet.ofSeq(elements, cmp);
  }

  toString(): string {
    const items = this.toList().slice(0, 8).map((x) => String(x)).join("; ");
    return `HashSet [${items}${this.count > 8 ? "; ..." : ""}]`;
  }
}

// ---------------------------------------------------------------------------
// Public HashMap<K, V>
// ---------------------------------------------------------------------------

// Small-map threshold: flat maps at or below this size skip the trie
// entirely (scene-templates M2 — a scene holds tens of thousands of
// 1..3-entry maps). Above it, or on any operation without a flat fast
// path, the trie is built lazily via the `_root` getter and the map
// behaves EXACTLY as before — the flat form is an optimization of
// representation, never of semantics.
const SMALL_MAP_MAX = 16;

export class HashMap<K, V> implements Iterable<[K, V]> {
  /** @internal */
  readonly _cmp: IEqualityComparer<K>;
  /** Trie root cache; `undefined` = flat-backed, not yet built. @internal */
  private _rootCache: SetNode<K> | null | undefined;
  // Flat small representation: ONE interleaved array
  // [h0, k0, v0, h1, k1, v1, ...] in insertion order — a 2-entry map
  // is wrapper + one array, cheaper than any trie shape. Invariants:
  // keys unique; values never `undefined` (the node ops treat
  // undefined ambiguously, so flat paths bail to the trie for them);
  // ≤ SMALL_MAP_MAX entries.
  private _f: unknown[] | null = null;

  /** @internal */
  constructor(cmp: IEqualityComparer<K>, root: SetNode<K> | null) {
    this._cmp = cmp;
    this._rootCache = root;
  }

  private static smallOf<K, V>(
    cmp: IEqualityComparer<K>,
    f: unknown[],
  ): HashMap<K, V> {
    const m = new HashMap<K, V>(cmp, null);
    m._rootCache = undefined;
    m._f = f;
    return m;
  }

  /** True while this map is served by the flat representation. */
  private get isFlat(): boolean {
    return this._rootCache === undefined;
  }

  /** @internal — lazily builds the canonical trie from the flat form. */
  get _root(): SetNode<K> | null {
    let r = this._rootCache;
    if (r === undefined) {
      let n: SetNode<K> | null = null;
      const f = this._f!;
      for (let i = 0; i < f.length; i += 3) {
        n = MapNodeOps.add(this._cmp, f[i] as number, f[i + 1] as K, f[i + 2] as V, n);
      }
      this._rootCache = r = n;
    }
    return r;
  }

  /** Index into `_f` (multiple of 3), or -1. */
  private flatIndex(hash: number, key: K): number {
    const f = this._f!;
    for (let i = 0; i < f.length; i += 3) {
      if (f[i] === hash && this._cmp.equals(f[i + 1] as K, key)) return i;
    }
    return -1;
  }

  get count(): number {
    if (this.isFlat) return this._f!.length / 3;
    return size(this._root);
  }
  get isEmpty(): boolean {
    if (this.isFlat) return this._f!.length === 0;
    return this._root === null;
  }

  containsKey(key: K): boolean {
    if (this.isFlat) return this.flatIndex(hashKey(this._cmp, key), key) >= 0;
    return MapNodeOps.containsKey<K, V>(this._cmp, hashKey(this._cmp, key), key, this._root);
  }

  tryFind(key: K): V | undefined {
    if (this.isFlat) {
      const i = this.flatIndex(hashKey(this._cmp, key), key);
      return i >= 0 ? (this._f![i + 2] as V) : undefined;
    }
    return MapNodeOps.tryFind<K, V>(this._cmp, hashKey(this._cmp, key), key, this._root);
  }
  tryFindV(key: K): V | undefined {
    return this.tryFind(key);
  }
  get(key: K): V {
    const v = this.tryFind(key);
    if (v === undefined && !this.containsKey(key)) {
      throw new Error(`HashMap: key not found: ${String(key)}`);
    }
    return v as V;
  }

  add(key: K, value: V): HashMap<K, V> {
    if (this.isFlat && value !== undefined) {
      const h = hashKey(this._cmp, key);
      const i = this.flatIndex(h, key);
      const f = this._f!;
      if (i >= 0) {
        const nf = f.slice();
        nf[i + 2] = value;
        return HashMap.smallOf<K, V>(this._cmp, nf);
      }
      if (f.length < SMALL_MAP_MAX * 3) {
        const nf = f.slice();
        nf.push(h, key, value);
        return HashMap.smallOf<K, V>(this._cmp, nf);
      }
      // crosses the threshold — fall through onto the trie (built once
      // via the getter, then extended).
    }
    return new HashMap<K, V>(
      this._cmp,
      MapNodeOps.add(this._cmp, hashKey(this._cmp, key), key, value, this._root),
    );
  }

  remove(key: K): HashMap<K, V> {
    if (this.isFlat) {
      const i = this.flatIndex(hashKey(this._cmp, key), key);
      if (i < 0) return this;
      const nf = this._f!.slice();
      nf.splice(i, 3);
      return HashMap.smallOf<K, V>(this._cmp, nf);
    }
    const [v, root] = MapNodeOps.tryRemove<K, V>(
      this._cmp,
      hashKey(this._cmp, key),
      key,
      this._root,
    );
    if (v === undefined && !this.containsKey(key)) return this;
    return new HashMap<K, V>(this._cmp, root);
  }

  tryRemove(key: K): { value: V; rest: HashMap<K, V> } | undefined {
    if (this.isFlat) {
      const i = this.flatIndex(hashKey(this._cmp, key), key);
      if (i < 0) return undefined;
      const value = this._f![i + 2] as V;
      const nf = this._f!.slice();
      nf.splice(i, 3);
      return { value, rest: HashMap.smallOf<K, V>(this._cmp, nf) };
    }
    const [v, root] = MapNodeOps.tryRemove<K, V>(
      this._cmp,
      hashKey(this._cmp, key),
      key,
      this._root,
    );
    if (v === undefined) return undefined;
    return { value: v, rest: new HashMap<K, V>(this._cmp, root) };
  }

  alter(key: K, update: (existing: V | undefined) => V | undefined): HashMap<K, V> {
    return new HashMap<K, V>(
      this._cmp,
      MapNodeOps.alter(this._cmp, hashKey(this._cmp, key), key, update, this._root),
    );
  }
  alterV(key: K, update: (existing: V | undefined) => V | undefined): HashMap<K, V> {
    return this.alter(key, update);
  }

  /**
   * Like `alter` but cannot remove. Receives the existing value (or
   * undefined) and must return a value to set.
   */
  update(key: K, mapping: (existing: V | undefined) => V): HashMap<K, V> {
    return this.alter(key, mapping);
  }

  /**
   * Pairs this map's values with `other`'s, calling `mapping` for
   * every key in either map.
   */
  map2<T, U>(
    other: HashMap<K, T>,
    mapping: (k: K, v: V | undefined, t: T | undefined) => U,
  ): HashMap<K, U> {
    return this.choose2V<T, U>(other, mapping);
  }

  iter(action: (k: K, v: V) => void): void {
    if (this.isFlat) {
      const f = this._f!;
      for (let i = 0; i < f.length; i += 3) action(f[i + 1] as K, f[i + 2] as V);
      return;
    }
    MapNodeOps.iter(action, this._root);
  }
  fold<S>(folder: (s: S, k: K, v: V) => S, state: S): S {
    if (this.isFlat) {
      const f = this._f!;
      let acc = state;
      for (let i = 0; i < f.length; i += 3) acc = folder(acc, f[i + 1] as K, f[i + 2] as V);
      return acc;
    }
    return MapNodeOps.fold(folder, state, this._root);
  }
  exists(predicate: (k: K, v: V) => boolean): boolean {
    if (this.isFlat) {
      const f = this._f!;
      for (let i = 0; i < f.length; i += 3) if (predicate(f[i + 1] as K, f[i + 2] as V)) return true;
      return false;
    }
    return MapNodeOps.exists(predicate, this._root);
  }
  forall(predicate: (k: K, v: V) => boolean): boolean {
    if (this.isFlat) {
      const f = this._f!;
      for (let i = 0; i < f.length; i += 3) if (!predicate(f[i + 1] as K, f[i + 2] as V)) return false;
      return true;
    }
    return MapNodeOps.forall(predicate, this._root);
  }

  map<U>(mapping: (k: K, v: V) => U): HashMap<K, U> {
    if (this.isFlat) {
      const f = this._f!;
      const nf = f.slice();
      let flatOk = true;
      for (let i = 0; i < f.length; i += 3) {
        const u = mapping(f[i + 1] as K, f[i + 2] as V);
        if (u === undefined) { flatOk = false; break; }
        nf[i + 2] = u;
      }
      if (flatOk) return HashMap.smallOf<K, U>(this._cmp, nf);
      // undefined values can't ride the flat form — use the trie path.
    }
    return new HashMap<K, U>(this._cmp, MapNodeOps.map(mapping, this._root));
  }
  choose<U>(mapping: (k: K, v: V) => U | undefined): HashMap<K, U> {
    if (this.isFlat) {
      const f = this._f!;
      const nf: unknown[] = [];
      for (let i = 0; i < f.length; i += 3) {
        const u = mapping(f[i + 1] as K, f[i + 2] as V);
        if (u !== undefined) nf.push(f[i], f[i + 1], u);
      }
      return HashMap.smallOf<K, U>(this._cmp, nf);
    }
    return new HashMap<K, U>(this._cmp, MapNodeOps.choose(mapping, this._root));
  }
  filter(predicate: (k: K, v: V) => boolean): HashMap<K, V> {
    if (this.isFlat) {
      const f = this._f!;
      const nf: unknown[] = [];
      for (let i = 0; i < f.length; i += 3) {
        if (predicate(f[i + 1] as K, f[i + 2] as V)) nf.push(f[i], f[i + 1], f[i + 2]);
      }
      return HashMap.smallOf<K, V>(this._cmp, nf);
    }
    return new HashMap<K, V>(this._cmp, MapNodeOps.filter(predicate, this._root));
  }

  unionWith(
    other: HashMap<K, V>,
    resolve?: (k: K, a: V, b: V) => V,
  ): HashMap<K, V> {
    if (resolve !== undefined) {
      return new HashMap<K, V>(
        this._cmp,
        MapNodeOps.unionWith(this._cmp, resolve, this._root, other._root),
      );
    }
    return new HashMap<K, V>(this._cmp, MapNodeOps.union<K, V>(this._cmp, this._root, other._root));
  }

  intersect<T>(other: HashMap<K, T>): HashMap<K, [V, T]> {
    return new HashMap<K, [V, T]>(
      this._cmp,
      MapNodeOps.intersect<K, V, T, [V, T]>(
        this._cmp,
        (_k, v, t) => [v, t],
        this._root,
        other._root,
      ),
    );
  }

  intersectWith<T, U>(
    other: HashMap<K, T>,
    resolve: (k: K, v: V, t: T) => U,
  ): HashMap<K, U> {
    return new HashMap<K, U>(
      this._cmp,
      MapNodeOps.intersect<K, V, T, U>(this._cmp, resolve, this._root, other._root),
    );
  }

  intersectionCount<T>(other: HashMap<K, T>): number {
    let n = 0;
    MapNodeOps.iter<K, V>((k, _v) => {
      if (other.containsKey(k)) n += 1;
    }, this._root);
    return n;
  }

  /**
   * `choose2V`: combine two maps with a per-key resolver. Linear in the
   * union of keys.
   */
  choose2V<T, U>(
    other: HashMap<K, T>,
    mapping: (k: K, v: V | undefined, t: T | undefined) => U | undefined,
  ): HashMap<K, U> {
    let out = HashMap.empty<K, U>(this._cmp);
    MapNodeOps.iter<K, V>((k, v) => {
      const t = other.tryFind(k);
      const u = mapping(k, v, other.containsKey(k) ? t : undefined);
      if (u !== undefined) out = out.add(k, u);
    }, this._root);
    MapNodeOps.iter<K, T>((k, t) => {
      if (this.containsKey(k)) return;
      const u = mapping(k, undefined, t);
      if (u !== undefined) out = out.add(k, u);
    }, other._root);
    return out;
  }

  map2V<T, U>(
    other: HashMap<K, T>,
    mapping: (k: K, v: V | undefined, t: T | undefined) => U,
  ): HashMap<K, U> {
    return this.choose2V<T, U>(other, mapping);
  }

  static applyDeltaV<K, V, D, DOut>(
    state: HashMap<K, V>,
    delta: HashMap<K, D>,
    apply: (k: K, existing: V | undefined, d: D) => [V | undefined, DOut | undefined],
  ): { state: HashMap<K, V>; effective: HashMap<K, DOut> } {
    const [eff, st] = MapNodeOps.applyDelta<K, V, D, DOut>(
      state._cmp,
      apply,
      state._root,
      delta._root,
    );
    return {
      state: new HashMap<K, V>(state._cmp, st),
      effective: new HashMap<K, DOut>(state._cmp, eff),
    };
  }

  static applyDelta<K, V, D, DOut>(
    state: HashMap<K, V>,
    delta: HashMap<K, D>,
    apply: (k: K, existing: V | undefined, d: D) => [V | undefined, DOut | undefined],
  ): { state: HashMap<K, V>; effective: HashMap<K, DOut> } {
    return HashMap.applyDeltaV(state, delta, apply);
  }

  static applyDeltaToSet<K, D, DOut>(
    state: HashSet<K>,
    delta: HashMap<K, D>,
    apply: (k: K, existing: boolean, d: D) => [boolean, DOut | undefined],
  ): { state: HashSet<K>; effective: HashMap<K, DOut> } {
    const [eff, st] = SetNodeOps.applyDelta<K, D, DOut>(
      state._cmp,
      apply,
      state._root,
      delta._root,
    );
    return {
      state: new HashSet<K>(state._cmp, st),
      effective: new HashMap<K, DOut>(state._cmp, eff),
    };
  }

  getKeys(): HashSet<K> {
    // The underlying SetNode shape works for both HashSet and HashMap;
    // the value side is just ignored when iterating as a set.
    return new HashSet<K>(this._cmp, this._root);
  }

  toList(): Array<[K, V]> {
    if (this.isFlat) {
      const f = this._f!;
      const out: Array<[K, V]> = new Array(f.length / 3);
      for (let i = 0; i < f.length; i += 3) out[i / 3] = [f[i + 1] as K, f[i + 2] as V];
      return out;
    }
    return MapNodeOps.toList<K, V>([], this._root);
  }
  toArray(): Array<[K, V]> {
    return this.toList();
  }
  toKeyArray(): K[] {
    return this.toList().map((kv) => kv[0]);
  }
  toValueArray(): V[] {
    if (this.isFlat) {
      const f = this._f!;
      const out: V[] = new Array(f.length / 3);
      for (let i = 0; i < f.length; i += 3) out[i / 3] = f[i + 2] as V;
      return out;
    }
    return MapNodeOps.toValueList<K, V>([], this._root);
  }
  toKeyList(): K[] {
    return this.toKeyArray();
  }
  toValueList(): V[] {
    return this.toValueArray();
  }
  toSeq(): Iterable<[K, V]> {
    return this;
  }
  toKeySeq(): Iterable<K> {
    return this.toKeyArray();
  }
  toValueSeq(): Iterable<V> {
    return this.toValueArray();
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    if (this.isFlat) {
      const f = this._f!;
      for (let i = 0; i < f.length; i += 3) yield [f[i + 1] as K, f[i + 2] as V];
      return;
    }
    const stack: Array<SetNode<K> | null> = [this._root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node === null) continue;
      if (node.isLeaf) {
        const leaf = node as MapLeaf<K, V>;
        yield [leaf.key, leaf.value];
        let cur = leaf.mapNext;
        while (cur !== null) {
          yield [cur.key, cur.value];
          cur = cur.mapNext;
        }
      } else {
        const inner = node as Inner<K>;
        stack.push(inner.right);
        stack.push(inner.left);
      }
    }
  }

  equals(other: HashMap<K, V>): boolean {
    if (this.count !== other.count) return false;
    return MapNodeOps.equals<K, V>(this._cmp, this._root, other._root);
  }

  /**
   * Structural hash — matches the equality contract on
   * {key, value count, hash bucket layout}. Stable across
   * insertion-order variations.
   */
  getHash(): number {
    return SetNodeOps.hash(0, this._root);
  }

  private static readonly _emptyFlat: unknown[] = [];
  static empty<K, V>(cmp?: IEqualityComparer<K>): HashMap<K, V> {
    return HashMap.smallOf<K, V>(cmp ?? comparerFor<K>(), HashMap._emptyFlat);
  }
  static single<K, V>(key: K, value: V, cmp?: IEqualityComparer<K>): HashMap<K, V> {
    return HashMap.empty<K, V>(cmp).add(key, value);
  }
  static ofSeq<K, V>(
    elements: Iterable<[K, V]>,
    cmp?: IEqualityComparer<K>,
  ): HashMap<K, V> {
    let m = HashMap.empty<K, V>(cmp);
    for (const [k, v] of elements) m = m.add(k, v);
    return m;
  }
  static ofArray<K, V>(
    elements: Array<[K, V]>,
    cmp?: IEqualityComparer<K>,
  ): HashMap<K, V> {
    return HashMap.ofSeq(elements, cmp);
  }
  static ofList<K, V>(
    elements: Array<[K, V]>,
    cmp?: IEqualityComparer<K>,
  ): HashMap<K, V> {
    return HashMap.ofSeq(elements, cmp);
  }

  toString(): string {
    const items = this.toList()
      .slice(0, 8)
      .map(([k, v]) => `${String(k)} -> ${String(v)}`)
      .join("; ");
    return `HashMap [${items}${this.count > 8 ? "; ..." : ""}]`;
  }
}

// ---------------------------------------------------------------------------
// F# module surfaces
// ---------------------------------------------------------------------------

export const HashSetOps = {
  empty: <T>() => HashSet.empty<T>(),
  single: <T>(v: T) => HashSet.single(v),
  ofSeq: <T>(s: Iterable<T>) => HashSet.ofSeq(s),
  ofArray: <T>(a: T[]) => HashSet.ofArray(a),
  ofList: <T>(a: T[]) => HashSet.ofList(a),
  count: <T>(s: HashSet<T>) => s.count,
  isEmpty: <T>(s: HashSet<T>) => s.isEmpty,
  contains: <T>(v: T, s: HashSet<T>) => s.contains(v),
  add: <T>(v: T, s: HashSet<T>) => s.add(v),
  remove: <T>(v: T, s: HashSet<T>) => s.remove(v),
  tryRemove: <T>(v: T, s: HashSet<T>) => s.tryRemove(v),
  alter: <T>(v: T, u: (b: boolean) => boolean, s: HashSet<T>) => s.alter(v, u),
  iter: <T>(action: (k: T) => void, s: HashSet<T>) => s.iter(action),
  fold: <T, S>(folder: (s: S, k: T) => S, state: S, set: HashSet<T>) =>
    set.fold(folder, state),
  exists: <T>(p: (k: T) => boolean, s: HashSet<T>) => s.exists(p),
  forall: <T>(p: (k: T) => boolean, s: HashSet<T>) => s.forall(p),
  map: <T, U>(mapping: (k: T) => U, s: HashSet<T>) => s.map(mapping),
  choose: <T, U>(mapping: (k: T) => U | undefined, s: HashSet<T>) =>
    s.choose(mapping),
  filter: <T>(p: (k: T) => boolean, s: HashSet<T>) => s.filter(p),
  collect: <T, U>(mapping: (k: T) => HashSet<U>, s: HashSet<T>) => {
    let out = HashSet.empty<U>();
    for (const k of s) out = out.unionWith(mapping(k));
    return out;
  },
  head: <T>(s: HashSet<T>) => s.first(),
  toSeq: <T>(s: HashSet<T>): Iterable<T> => s,
  toList: <T>(s: HashSet<T>) => s.toList(),
  toArray: <T>(s: HashSet<T>) => s.toArray(),
  union: <T>(a: HashSet<T>, b: HashSet<T>) => a.unionWith(b),
  intersect: <T>(a: HashSet<T>, b: HashSet<T>) => a.intersectWith(b),
  xor: <T>(a: HashSet<T>, b: HashSet<T>) => a.symmetricExceptWith(b),
  difference: <T>(a: HashSet<T>, b: HashSet<T>) => a.exceptWith(b),
  intersectionCount: <T>(a: HashSet<T>, b: HashSet<T>) => a.intersectionCount(b),
  unionMany: <T>(sets: Iterable<HashSet<T>>) => {
    let out = HashSet.empty<T>();
    for (const s of sets) out = out.unionWith(s);
    return out;
  },
  intersectMany: <T>(sets: Iterable<HashSet<T>>) => {
    const arr = [...sets];
    if (arr.length === 0) return HashSet.empty<T>();
    let out = arr[0]!;
    for (let i = 1; i < arr.length; i++) out = out.intersectWith(arr[i]!);
    return out;
  },
  equals: <T>(a: HashSet<T>, b: HashSet<T>) => a.setEquals(b),
  overlaps: <T>(a: HashSet<T>, b: HashSet<T>) => a.overlaps(b),
  isSubset: <T>(a: HashSet<T>, b: HashSet<T>) => a.isSubsetOf(b),
  isProperSubset: <T>(a: HashSet<T>, b: HashSet<T>) => a.isProperSubsetOf(b),
  isSuperset: <T>(a: HashSet<T>, b: HashSet<T>) => a.isSupersetOf(b),
  isProperSuperset: <T>(a: HashSet<T>, b: HashSet<T>) => a.isProperSupersetOf(b),
};

export const HashMapOps = {
  empty: <K, V>() => HashMap.empty<K, V>(),
  single: <K, V>(k: K, v: V) => HashMap.single(k, v),
  ofSeq: <K, V>(s: Iterable<[K, V]>) => HashMap.ofSeq(s),
  ofArray: <K, V>(a: Array<[K, V]>) => HashMap.ofArray(a),
  ofList: <K, V>(a: Array<[K, V]>) => HashMap.ofList(a),
  count: <K, V>(m: HashMap<K, V>) => m.count,
  isEmpty: <K, V>(m: HashMap<K, V>) => m.isEmpty,
  containsKey: <K, V>(k: K, m: HashMap<K, V>) => m.containsKey(k),
  tryFind: <K, V>(k: K, m: HashMap<K, V>) => m.tryFind(k),
  add: <K, V>(k: K, v: V, m: HashMap<K, V>) => m.add(k, v),
  remove: <K, V>(k: K, m: HashMap<K, V>) => m.remove(k),
  alter: <K, V>(
    k: K,
    update: (existing: V | undefined) => V | undefined,
    m: HashMap<K, V>,
  ) => m.alter(k, update),
  iter: <K, V>(action: (k: K, v: V) => void, m: HashMap<K, V>) => m.iter(action),
  fold: <K, V, S>(folder: (s: S, k: K, v: V) => S, state: S, m: HashMap<K, V>) =>
    m.fold(folder, state),
  exists: <K, V>(p: (k: K, v: V) => boolean, m: HashMap<K, V>) => m.exists(p),
  forall: <K, V>(p: (k: K, v: V) => boolean, m: HashMap<K, V>) => m.forall(p),
  map: <K, V, U>(mapping: (k: K, v: V) => U, m: HashMap<K, V>) => m.map(mapping),
  choose: <K, V, U>(
    mapping: (k: K, v: V) => U | undefined,
    m: HashMap<K, V>,
  ) => m.choose(mapping),
  filter: <K, V>(p: (k: K, v: V) => boolean, m: HashMap<K, V>) => m.filter(p),
  union: <K, V>(a: HashMap<K, V>, b: HashMap<K, V>) => a.unionWith(b),
  unionWith: <K, V>(
    a: HashMap<K, V>,
    b: HashMap<K, V>,
    resolve: (k: K, l: V, r: V) => V,
  ) => a.unionWith(b, resolve),
  intersect: <K, V, T>(a: HashMap<K, V>, b: HashMap<K, T>) => a.intersect(b),
  intersectWith: <K, V, T, U>(
    a: HashMap<K, V>,
    b: HashMap<K, T>,
    resolve: (k: K, v: V, t: T) => U,
  ) => a.intersectWith(b, resolve),
  toSeq: <K, V>(m: HashMap<K, V>): Iterable<[K, V]> => m,
  toList: <K, V>(m: HashMap<K, V>) => m.toList(),
  toArray: <K, V>(m: HashMap<K, V>) => m.toArray(),
  toKeyArray: <K, V>(m: HashMap<K, V>) => m.toKeyArray(),
  toValueArray: <K, V>(m: HashMap<K, V>) => m.toValueArray(),
  keys: <K, V>(m: HashMap<K, V>) => m.getKeys(),
  equals: <K, V>(a: HashMap<K, V>, b: HashMap<K, V>) => a.equals(b),
};
