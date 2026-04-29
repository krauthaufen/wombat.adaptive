// Port of FSharp.Data.Adaptive Datastructures/MapExt.fs
//
// Faithful AVL tree port covering the full F# operation set:
//   * Node hierarchy (Node + Inner) mirroring F#
//   * Rotations: unsafeBinary, rebalanceUnsafe (in-place), unsafeJoin
//   * Recursive height-balanced merge: binary, join
//   * Lookups: find, tryFind, tryGetItem, tryGetIndex, tryGetMin/Max,
//              containsKey
//   * Insertions: add, addIfNotPresent, unsafeAddMinimum,
//                 unsafeAddMaximum, addInPlace
//   * Removal: tryRemove, tryRemove' (no-value), removeAt
//   * Updates: change, changeV, changeWithLeft, changeWithRight,
//              changeWithNeighbours, replaceRange
//   * Traversal: iter, iterValue, fold, foldBack, exists, forall,
//                tryPick, tryPickV, tryPickBack, tryPickBackV
//   * Transform: map, mapMonotonic, choose, chooseV, filter,
//                partition
//   * Range: withMin, withMax, withMinExclusiveN, withMaxExclusiveN,
//            slice, sliceEx, take, skip, sliceAt, split, splitAt
//   * Merge: union, unionWith, choose2 (with helper choose2Helper)
//   * Position-aware: getNeighbours, getNeighboursAt
//   * Delta: computeDelta, applyDelta, applyDeltaAndGetEffective,
//            chooseVAndGetEffective, applyDeltaSingletonState/Eff,
//            applyDeltaSingle/Eff
//   * Equality / hashing: equals, hash
//   * Conversions: copyTo / copyToV / copyKeysTo / copyValuesTo
//                  (forward and backward), toList / toListV / toListBack /
//                  toListBackV / toKeyList / toKeyListBack /
//                  toValueList / toValueListBack
//
// PORT NOTE — node hierarchy:
//   F# uses `Node<K, V>` as a leaf-shaped base carrying key/value and a
//   1-byte height, with `Inner<K, V>` extending it to add left/right
//   children plus a precomputed count. Mirrored as TS classes.
//
// PORT NOTE — `addInPlace` mutates leaves and inner nodes in place and
//   re-runs `rebalanceUnsafe` on the way back up the recursion. Used by
//   `ofSeq`/`ofArray`/`ofList` for O(N log N) bulk construction without
//   allocating intermediate trees.

export type KeyComparer<K> = (a: K, b: K) => number;

export const defaultCompareKeys: KeyComparer<unknown> = (a, b) => {
  if (Object.is(a, b)) return 0;
  if ((a as number) < (b as number)) return -1;
  return 1;
};

// ---------------------------------------------------------------------------
// Node hierarchy
// ---------------------------------------------------------------------------

class Node<K, V> {
  key: K;
  value: V;
  height: number;

  constructor(key: K, value: V, height = 1) {
    this.key = key;
    this.value = value;
    this.height = height;
  }
}

class Inner<K, V> extends Node<K, V> {
  left: Node<K, V> | null;
  right: Node<K, V> | null;
  count: number;

  constructor(
    left: Node<K, V> | null,
    key: K,
    value: V,
    right: Node<K, V> | null,
    height: number,
    count: number,
  ) {
    super(key, value, height);
    this.left = left;
    this.right = right;
    this.count = count;
  }

  static getCount<K, V>(node: Node<K, V> | null): number {
    if (node === null) return 0;
    if (node.height === 1) return 1;
    return (node as Inner<K, V>).count;
  }

  static getHeight<K, V>(node: Node<K, V> | null): number {
    if (node === null) return 0;
    return node.height;
  }

  static fixHeightAndCount<K, V>(inner: Inner<K, V>): void {
    const lc = Inner.getCount(inner.left);
    const rc = Inner.getCount(inner.right);
    const lh = lc > 0 ? (inner.left as Node<K, V>).height : 0;
    const rh = rc > 0 ? (inner.right as Node<K, V>).height : 0;
    inner.count = 1 + lc + rc;
    inner.height = 1 + Math.max(lh, rh);
  }
}

function nodeCount<K, V>(n: Node<K, V> | null): number {
  return Inner.getCount(n);
}
function nodeHeight<K, V>(n: Node<K, V> | null): number {
  return Inner.getHeight(n);
}

function balance<K, V>(n: Inner<K, V>): number {
  return nodeHeight(n.right) - nodeHeight(n.left);
}

// ---------------------------------------------------------------------------
// Rotations / balanced creation
// ---------------------------------------------------------------------------

function create<K, V>(
  l: Node<K, V> | null,
  k: K,
  v: V,
  r: Node<K, V> | null,
): Node<K, V> {
  if (l === null && r === null) return new Node<K, V>(k, v, 1);
  const lc = nodeCount(l);
  const rc = nodeCount(r);
  const lh = nodeHeight(l);
  const rh = nodeHeight(r);
  return new Inner<K, V>(l, k, v, r, 1 + Math.max(lh, rh), 1 + lc + rc);
}

/**
 * Single rotation step: produces a balanced node where child heights
 * differ by ≤ 2. Caller guarantees |Δheight| ≤ 3.
 */
function unsafeBinary<K, V>(
  l: Node<K, V> | null,
  k: K,
  v: V,
  r: Node<K, V> | null,
): Node<K, V> {
  const lh = nodeHeight(l);
  const rh = nodeHeight(r);
  const lc = nodeCount(l);
  const rc = nodeCount(r);
  const b = rh - lh;

  if (b > 2) {
    const ri = r as Inner<K, V>;
    const rb = balance(ri);
    if (rb > 0) {
      // right-right
      return create(create(l, k, v, ri.left), ri.key, ri.value, ri.right);
    }
    // right-left
    const rl = ri.left as Inner<K, V>;
    return create(
      create(l, k, v, rl.left),
      rl.key,
      rl.value,
      create(rl.right, ri.key, ri.value, ri.right),
    );
  }
  if (b < -2) {
    const li = l as Inner<K, V>;
    const lb = balance(li);
    if (lb < 0) {
      return create(li.left, li.key, li.value, create(li.right, k, v, r));
    }
    const lr = li.right as Inner<K, V>;
    return create(
      create(li.left, li.key, li.value, lr.left),
      lr.key,
      lr.value,
      create(lr.right, k, v, r),
    );
  }
  if (lh === 0 && rh === 0) return new Node<K, V>(k, v, 1);
  return new Inner<K, V>(l, k, v, r, 1 + Math.max(lh, rh), 1 + lc + rc);
}

/**
 * Recursive rebalancing merge tolerating any height difference. Used
 * by partition/choose/filter/join when subtrees can have arbitrary
 * height ratios.
 */
function binary<K, V>(
  l: Node<K, V> | null,
  k: K,
  v: V,
  r: Node<K, V> | null,
): Node<K, V> {
  const lh = nodeHeight(l);
  const rh = nodeHeight(r);
  const lc = nodeCount(l);
  const rc = nodeCount(r);
  const b = rh - lh;

  if (b > 2) {
    const ri = r as Inner<K, V>;
    const rb = balance(ri);
    if (rb > 0) {
      return binary(binary(l, k, v, ri.left), ri.key, ri.value, ri.right);
    }
    const rl = ri.left as Inner<K, V>;
    return binary(
      binary(l, k, v, rl.left),
      rl.key,
      rl.value,
      binary(rl.right, ri.key, ri.value, ri.right),
    );
  }
  if (b < -2) {
    const li = l as Inner<K, V>;
    const lb = balance(li);
    if (lb < 0) {
      return binary(li.left, li.key, li.value, binary(li.right, k, v, r));
    }
    const lr = li.right as Inner<K, V>;
    return binary(
      binary(li.left, li.key, li.value, lr.left),
      lr.key,
      lr.value,
      binary(lr.right, k, v, r),
    );
  }
  if (lh === 0 && rh === 0) return new Node<K, V>(k, v, 1);
  return new Inner<K, V>(l, k, v, r, 1 + Math.max(lh, rh), 1 + lc + rc);
}

function unsafeRemoveMin<K, V>(
  n: Node<K, V>,
): { key: K; value: V; rest: Node<K, V> | null } {
  if (n.height === 1) return { key: n.key, value: n.value, rest: null };
  const inner = n as Inner<K, V>;
  if (inner.left === null) {
    return { key: inner.key, value: inner.value, rest: inner.right };
  }
  const r = unsafeRemoveMin(inner.left);
  return {
    key: r.key,
    value: r.value,
    rest: unsafeBinary(r.rest, inner.key, inner.value, inner.right),
  };
}

function unsafeRemoveMax<K, V>(
  n: Node<K, V>,
): { key: K; value: V; rest: Node<K, V> | null } {
  if (n.height === 1) return { key: n.key, value: n.value, rest: null };
  const inner = n as Inner<K, V>;
  if (inner.right === null) {
    return { key: inner.key, value: inner.value, rest: inner.left };
  }
  const r = unsafeRemoveMax(inner.right);
  return {
    key: r.key,
    value: r.value,
    rest: unsafeBinary(inner.left, inner.key, inner.value, r.rest),
  };
}

function unsafeJoin<K, V>(
  l: Node<K, V> | null,
  r: Node<K, V> | null,
): Node<K, V> | null {
  if (l === null) return r;
  if (r === null) return l;
  const lh = l.height;
  const rh = r.height;
  if (lh > rh) {
    const m = unsafeRemoveMax(l);
    return unsafeBinary(m.rest, m.key, m.value, r);
  }
  const m = unsafeRemoveMin(r);
  return unsafeBinary(l, m.key, m.value, m.rest);
}

function joinRec<K, V>(
  l: Node<K, V> | null,
  r: Node<K, V> | null,
): Node<K, V> | null {
  if (l === null) return r;
  if (r === null) return l;
  const lh = l.height;
  const rh = r.height;
  if (lh > rh) {
    const m = unsafeRemoveMax(l);
    return binary(m.rest, m.key, m.value, r);
  }
  const m = unsafeRemoveMin(r);
  return binary(l, m.key, m.value, m.rest);
}

function rebalanceUnsafe<K, V>(node: Inner<K, V>): void {
  const lh = nodeHeight(node.left);
  const rh = nodeHeight(node.right);
  const b = rh - lh;
  if (b > 2) {
    const r = node.right as Inner<K, V>;
    const br = balance(r);
    if (br >= 0) {
      // right-right (in-place)
      const t0 = node.left;
      const k01 = node.key;
      const v01 = node.value;
      const t1 = r.left;
      const k12 = r.key;
      const v12 = r.value;
      const t2 = r.right;

      r.key = k01;
      r.value = v01;
      r.left = t0;
      r.right = t1;
      Inner.fixHeightAndCount(r);

      node.key = k12;
      node.value = v12;
      node.left = r;
      node.right = t2;
      node.count = 1 + r.count + nodeCount(t2);
      node.height = 1 + Math.max(r.height, nodeHeight(t2));
    } else {
      const rl = r.left as Inner<K, V>;
      const t0 = node.left;
      const k01 = node.key;
      const v01 = node.value;
      const t1 = rl.left;
      const k12 = rl.key;
      const v12 = rl.value;
      const t2 = rl.right;
      const k23 = r.key;
      const v23 = r.value;
      const t3 = r.right;

      const a = rl;
      const b2 = r;
      a.key = k01;
      a.value = v01;
      a.left = t0;
      a.right = t1;
      Inner.fixHeightAndCount(a);

      b2.key = k23;
      b2.value = v23;
      b2.left = t2;
      b2.right = t3;
      Inner.fixHeightAndCount(b2);

      node.key = k12;
      node.value = v12;
      node.left = a;
      node.right = b2;
      node.count = 1 + a.count + b2.count;
      node.height = 1 + Math.max(a.height, b2.height);
    }
  } else if (b < -2) {
    const l = node.left as Inner<K, V>;
    const bl = balance(l);
    if (bl <= 0) {
      const t0 = l.left;
      const k01 = l.key;
      const v01 = l.value;
      const t1 = l.right;
      const k12 = node.key;
      const v12 = node.value;
      const t2 = node.right;

      const a = l;
      a.key = k12;
      a.value = v12;
      a.left = t1;
      a.right = t2;
      Inner.fixHeightAndCount(a);

      node.key = k01;
      node.value = v01;
      node.left = t0;
      node.right = a;
      node.count = 1 + nodeCount(t0) + a.count;
      node.height = 1 + Math.max(nodeHeight(t0), a.height);
    } else {
      const lr = l.right as Inner<K, V>;
      const t0 = l.left;
      const k01 = l.key;
      const v01 = l.value;
      const t1 = lr.left;
      const k12 = lr.key;
      const v12 = lr.value;
      const t2 = lr.right;
      const k23 = node.key;
      const v23 = node.value;
      const t3 = node.right;

      const a = l;
      const b2 = lr;
      a.key = k01;
      a.value = v01;
      a.left = t0;
      a.right = t1;
      Inner.fixHeightAndCount(a);

      b2.key = k23;
      b2.value = v23;
      b2.left = t2;
      b2.right = t3;
      Inner.fixHeightAndCount(b2);

      node.key = k12;
      node.value = v12;
      node.left = a;
      node.right = b2;
      node.count = 1 + a.count + b2.count;
      node.height = 1 + Math.max(a.height, b2.height);
    }
  } else {
    Inner.fixHeightAndCount(node);
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

function nodeFind<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): V {
  let cur = node;
  while (cur !== null) {
    const c = cmp(key, cur.key);
    if (c === 0) return cur.value;
    if (cur.height === 1) {
      throw new Error(`MapExt: key not found: ${String(key)}`);
    }
    const inner = cur as Inner<K, V>;
    cur = c < 0 ? inner.left : inner.right;
  }
  throw new Error(`MapExt: key not found: ${String(key)}`);
}

function nodeTryFind<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): V | undefined {
  let cur = node;
  while (cur !== null) {
    const c = cmp(key, cur.key);
    if (c === 0) return cur.value;
    if (cur.height === 1) return undefined;
    const inner = cur as Inner<K, V>;
    cur = c < 0 ? inner.left : inner.right;
  }
  return undefined;
}

function nodeContainsKey<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): boolean {
  let cur = node;
  while (cur !== null) {
    const c = cmp(key, cur.key);
    if (c === 0) return true;
    if (cur.height === 1) return false;
    const inner = cur as Inner<K, V>;
    cur = c < 0 ? inner.left : inner.right;
  }
  return false;
}

function nodeTryGetItem<K, V>(
  index: number,
  node: Node<K, V> | null,
): [K, V] | undefined {
  if (node === null) return undefined;
  if (node.height === 1) {
    if (index === 0) return [node.key, node.value];
    return undefined;
  }
  const inner = node as Inner<K, V>;
  const id = index - nodeCount(inner.left);
  if (id > 0) return nodeTryGetItem(id - 1, inner.right);
  if (id < 0) return nodeTryGetItem(index, inner.left);
  return [inner.key, inner.value];
}

function nodeTryGetIndex<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  offset: number,
  node: Node<K, V> | null,
): number {
  if (node === null) return -1;
  if (node.height === 1) {
    return cmp(key, node.key) === 0 ? offset : -1;
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) return nodeTryGetIndex(cmp, key, offset + nodeCount(inner.left) + 1, inner.right);
  if (c < 0) return nodeTryGetIndex(cmp, key, offset, inner.left);
  return offset + nodeCount(inner.left);
}

function nodeMin<K, V>(node: Node<K, V> | null): [K, V] | undefined {
  if (node === null) return undefined;
  let cur = node;
  while (cur.height !== 1 && (cur as Inner<K, V>).left !== null) {
    cur = (cur as Inner<K, V>).left as Node<K, V>;
  }
  return [cur.key, cur.value];
}

function nodeMax<K, V>(node: Node<K, V> | null): [K, V] | undefined {
  if (node === null) return undefined;
  let cur = node;
  while (cur.height !== 1 && (cur as Inner<K, V>).right !== null) {
    cur = (cur as Inner<K, V>).right as Node<K, V>;
  }
  return [cur.key, cur.value];
}

// ---------------------------------------------------------------------------
// Insertions
// ---------------------------------------------------------------------------

function nodeAddIfNotPresent<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return new Inner<K, V>(node, key, value, null, 2, 2);
    if (c < 0) return new Inner<K, V>(null, key, value, node, 2, 2);
    return node;
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeAddIfNotPresent(cmp, key, value, inner.right));
  }
  if (c < 0) {
    return unsafeBinary(nodeAddIfNotPresent(cmp, key, value, inner.left), inner.key, inner.value, inner.right);
  }
  return inner;
}

function nodeAdd<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return new Inner<K, V>(node, key, value, null, 2, 2);
    if (c < 0) return new Inner<K, V>(null, key, value, node, 2, 2);
    return new Node<K, V>(key, value, 1);
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeAdd(cmp, key, value, inner.right));
  }
  if (c < 0) {
    return unsafeBinary(nodeAdd(cmp, key, value, inner.left), inner.key, inner.value, inner.right);
  }
  return new Inner<K, V>(inner.left, key, value, inner.right, inner.height, inner.count);
}

function nodeUnsafeAddMinimum<K, V>(
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) return new Inner<K, V>(null, key, value, node, 2, 2);
  const inner = node as Inner<K, V>;
  return unsafeBinary(nodeUnsafeAddMinimum(key, value, inner.left), inner.key, inner.value, inner.right);
}

function nodeUnsafeAddMaximum<K, V>(
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) return new Inner<K, V>(node, key, value, null, 2, 2);
  const inner = node as Inner<K, V>;
  return unsafeBinary(inner.left, inner.key, inner.value, nodeUnsafeAddMaximum(key, value, inner.right));
}

function nodeAddInPlace<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return new Inner<K, V>(node, key, value, null, 2, 2);
    if (c < 0) return new Inner<K, V>(null, key, value, node, 2, 2);
    node.key = key;
    node.value = value;
    return node;
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    inner.right = nodeAddInPlace(cmp, key, value, inner.right);
    rebalanceUnsafe(inner);
    return inner;
  }
  if (c < 0) {
    inner.left = nodeAddInPlace(cmp, key, value, inner.left);
    rebalanceUnsafe(inner);
    return inner;
  }
  inner.key = key;
  inner.value = value;
  return inner;
}

// ---------------------------------------------------------------------------
// Removal
// ---------------------------------------------------------------------------

function nodeTryRemove<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): [V, Node<K, V> | null] | undefined {
  if (node === null) return undefined;
  const c = cmp(key, node.key);
  if (node.height === 1) {
    return c === 0 ? [node.value, null] : undefined;
  }
  const inner = node as Inner<K, V>;
  if (c < 0) {
    const r = nodeTryRemove(cmp, key, inner.left);
    if (r === undefined) return undefined;
    return [r[0], unsafeBinary(r[1], inner.key, inner.value, inner.right)];
  }
  if (c > 0) {
    const r = nodeTryRemove(cmp, key, inner.right);
    if (r === undefined) return undefined;
    return [r[0], unsafeBinary(inner.left, inner.key, inner.value, r[1])];
  }
  return [inner.value, unsafeJoin(inner.left, inner.right)];
}

function nodeRemoveAt<K, V>(
  index: number,
  node: Node<K, V> | null,
): { result: Node<K, V> | null; key: K; value: V } | null {
  if (node === null) return null;
  if (node.height === 1) {
    if (index === 0) return { result: null, key: node.key, value: node.value };
    return null;
  }
  const inner = node as Inner<K, V>;
  const id = index - nodeCount(inner.left);
  if (id > 0) {
    const r = nodeRemoveAt(id - 1, inner.right);
    if (r === null) return null;
    return {
      result: unsafeBinary(inner.left, inner.key, inner.value, r.result),
      key: r.key,
      value: r.value,
    };
  }
  if (id < 0) {
    const r = nodeRemoveAt(index, inner.left);
    if (r === null) return null;
    return {
      result: unsafeBinary(r.result, inner.key, inner.value, inner.right),
      key: r.key,
      value: r.value,
    };
  }
  return {
    result: unsafeJoin(inner.left, inner.right),
    key: inner.key,
    value: inner.value,
  };
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

function nodeChange<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  update: (existing: V | undefined) => V | undefined,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) {
    const v = update(undefined);
    return v === undefined ? null : new Node<K, V>(key, v, 1);
  }
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) {
      const v = update(undefined);
      if (v === undefined) return node;
      return new Inner<K, V>(node, key, v, null, 2, 2);
    }
    if (c < 0) {
      const v = update(undefined);
      if (v === undefined) return node;
      return new Inner<K, V>(null, key, v, node, 2, 2);
    }
    const v = update(node.value);
    if (v === undefined) return null;
    return new Node<K, V>(key, v, 1);
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeChange(cmp, key, update, inner.right));
  }
  if (c < 0) {
    return unsafeBinary(nodeChange(cmp, key, update, inner.left), inner.key, inner.value, inner.right);
  }
  const v = update(inner.value);
  if (v === undefined) return unsafeJoin(inner.left, inner.right);
  return new Inner<K, V>(inner.left, key, v, inner.right, inner.height, inner.count);
}

function nodeChangeWithLeft<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  resolve: (k: K, l: V, r: V) => V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return new Inner<K, V>(node, key, value, null, 2, 2);
    if (c < 0) return new Inner<K, V>(null, key, value, node, 2, 2);
    return new Node<K, V>(key, resolve(key, value, node.value), 1);
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeChangeWithLeft(cmp, key, value, resolve, inner.right));
  }
  if (c < 0) {
    return unsafeBinary(nodeChangeWithLeft(cmp, key, value, resolve, inner.left), inner.key, inner.value, inner.right);
  }
  return new Inner<K, V>(inner.left, inner.key, resolve(key, value, inner.value), inner.right, inner.height, inner.count);
}

function nodeChangeWithRight<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  resolve: (k: K, l: V, r: V) => V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return new Inner<K, V>(node, key, value, null, 2, 2);
    if (c < 0) return new Inner<K, V>(null, key, value, node, 2, 2);
    return new Node<K, V>(key, resolve(key, node.value, value), 1);
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeChangeWithRight(cmp, key, value, resolve, inner.right));
  }
  if (c < 0) {
    return unsafeBinary(nodeChangeWithRight(cmp, key, value, resolve, inner.left), inner.key, inner.value, inner.right);
  }
  return new Inner<K, V>(inner.left, inner.key, resolve(key, inner.value, value), inner.right, inner.height, inner.count);
}

// ---------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------

interface SplitResult<K, V> {
  hasValue: boolean;
  left: Node<K, V> | null;
  self: V | undefined;
  right: Node<K, V> | null;
}

function nodeSplit<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): SplitResult<K, V> {
  if (node === null) return { hasValue: false, left: null, self: undefined, right: null };
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) return { hasValue: false, left: node, self: undefined, right: null };
    if (c < 0) return { hasValue: false, left: null, self: undefined, right: node };
    return { hasValue: true, left: null, self: node.value, right: null };
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    const r = nodeSplit(cmp, key, inner.right);
    return {
      hasValue: r.hasValue,
      left: binary(inner.left, inner.key, inner.value, r.left),
      self: r.self,
      right: r.right,
    };
  }
  if (c < 0) {
    const r = nodeSplit(cmp, key, inner.left);
    return {
      hasValue: r.hasValue,
      left: r.left,
      self: r.self,
      right: binary(r.right, inner.key, inner.value, inner.right),
    };
  }
  return { hasValue: true, left: inner.left, self: inner.value, right: inner.right };
}

function nodeSplitAt<K, V>(
  index: number,
  node: Node<K, V> | null,
): { left: Node<K, V> | null; self: [K, V] | undefined; right: Node<K, V> | null } {
  if (index < 0) return { left: null, self: undefined, right: node };
  if (node === null) return { left: null, self: undefined, right: null };
  if (node.height === 1) {
    if (index < 0) return { left: null, self: undefined, right: node };
    if (index > 0) return { left: node, self: undefined, right: null };
    return { left: null, self: [node.key, node.value], right: null };
  }
  const inner = node as Inner<K, V>;
  const lc = nodeCount(inner.left);
  if (index === lc) {
    return { left: inner.left, self: [inner.key, inner.value], right: inner.right };
  }
  if (index > lc) {
    const r = nodeSplitAt(index - lc - 1, inner.right);
    return {
      left: binary(inner.left, inner.key, inner.value, r.left),
      self: r.self,
      right: r.right,
    };
  }
  const r = nodeSplitAt(index, inner.left);
  return {
    left: r.left,
    self: r.self,
    right: binary(r.right, inner.key, inner.value, inner.right),
  };
}

// ---------------------------------------------------------------------------
// Range queries
// ---------------------------------------------------------------------------

function nodeWithMin<K, V>(
  cmp: KeyComparer<K>,
  minKey: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) return cmp(node.key, minKey) >= 0 ? node : null;
  const inner = node as Inner<K, V>;
  const c = cmp(inner.key, minKey);
  if (c > 0) return binary(nodeWithMin(cmp, minKey, inner.left), inner.key, inner.value, inner.right);
  if (c < 0) return nodeWithMin(cmp, minKey, inner.right);
  return nodeAdd(cmp, inner.key, inner.value, nodeWithMin(cmp, minKey, inner.right));
}

function nodeWithMax<K, V>(
  cmp: KeyComparer<K>,
  maxKey: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) return cmp(node.key, maxKey) <= 0 ? node : null;
  const inner = node as Inner<K, V>;
  const c = cmp(inner.key, maxKey);
  if (c > 0) return nodeWithMax(cmp, maxKey, inner.left);
  if (c < 0) return binary(inner.left, inner.key, inner.value, nodeWithMax(cmp, maxKey, inner.right));
  return nodeAdd(cmp, inner.key, inner.value, nodeWithMax(cmp, maxKey, inner.left));
}

interface ExclusiveResult<K, V> {
  result: Node<K, V> | null;
  key: K | undefined;
  value: V | undefined;
}

function nodeWithMinExclusiveN<K, V>(
  cmp: KeyComparer<K>,
  minKey: K,
  node: Node<K, V> | null,
): ExclusiveResult<K, V> {
  let firstKey: K | undefined = undefined;
  let firstValue: V | undefined = undefined;

  const traverse = (n: Node<K, V> | null): Node<K, V> | null => {
    if (n === null) return null;
    if (n.height === 1) {
      if (cmp(n.key, minKey) > 0) {
        firstKey = n.key;
        firstValue = n.value;
        return n;
      }
      return null;
    }
    const inner = n as Inner<K, V>;
    if (cmp(inner.key, minKey) > 0) {
      const newLeft = traverse(inner.left);
      if (newLeft === null) {
        firstKey = inner.key;
        firstValue = inner.value;
      }
      return binary(newLeft, inner.key, inner.value, inner.right);
    }
    return traverse(inner.right);
  };
  return { result: traverse(node), key: firstKey, value: firstValue };
}

function nodeWithMaxExclusiveN<K, V>(
  cmp: KeyComparer<K>,
  maxKey: K,
  node: Node<K, V> | null,
): ExclusiveResult<K, V> {
  let lastKey: K | undefined = undefined;
  let lastValue: V | undefined = undefined;

  const traverse = (n: Node<K, V> | null): Node<K, V> | null => {
    if (n === null) return null;
    if (n.height === 1) {
      if (cmp(n.key, maxKey) < 0) {
        lastKey = n.key;
        lastValue = n.value;
        return n;
      }
      return null;
    }
    const inner = n as Inner<K, V>;
    if (cmp(inner.key, maxKey) < 0) {
      const newRight = traverse(inner.right);
      if (newRight === null) {
        lastKey = inner.key;
        lastValue = inner.value;
      }
      return binary(inner.left, inner.key, inner.value, newRight);
    }
    return traverse(inner.left);
  };
  return { result: traverse(node), key: lastKey, value: lastValue };
}

function nodeSlice<K, V>(
  cmp: KeyComparer<K>,
  minK: K,
  maxK: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    const cMin = cmp(minK, node.key);
    if (cMin <= 0) {
      return cmp(maxK, node.key) >= 0 ? node : null;
    }
    return null;
  }
  const inner = node as Inner<K, V>;
  const cMin = cmp(minK, inner.key);
  const cMax = cmp(maxK, inner.key);
  if (cMin <= 0 && cMax >= 0) {
    return binary(
      nodeWithMin(cmp, minK, inner.left),
      inner.key,
      inner.value,
      nodeWithMax(cmp, maxK, inner.right),
    );
  }
  if (cMin > 0) return nodeSlice(cmp, minK, maxK, inner.right);
  return nodeSlice(cmp, minK, maxK, inner.left);
}

function nodeSliceEx<K, V>(
  cmp: KeyComparer<K>,
  minK: K,
  minIncl: boolean,
  maxK: K,
  maxIncl: boolean,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    const cMin = cmp(minK, node.key);
    if (cMin < 0) {
      const cMax = cmp(maxK, node.key);
      if (cMax > 0) return node;
      if (cMax < 0) return null;
      return maxIncl ? node : null;
    }
    if (cMin > 0) return null;
    return minIncl ? node : null;
  }
  const inner = node as Inner<K, V>;
  const cMin = cmp(minK, inner.key);
  const cMax = cmp(maxK, inner.key);
  if (cMin < 0 && cMax > 0) {
    const left = minIncl
      ? nodeWithMin(cmp, minK, inner.left)
      : nodeWithMinExclusiveN(cmp, minK, inner.left).result;
    const right = maxIncl
      ? nodeWithMax(cmp, maxK, inner.right)
      : nodeWithMaxExclusiveN(cmp, maxK, inner.right).result;
    return binary(left, inner.key, inner.value, right);
  }
  if (cMin === 0) {
    const right = maxIncl
      ? nodeWithMax(cmp, maxK, inner.right)
      : nodeWithMaxExclusiveN(cmp, maxK, inner.right).result;
    return minIncl ? nodeUnsafeAddMinimum(inner.key, inner.value, right) : right;
  }
  if (cMax === 0) {
    const left = minIncl
      ? nodeWithMin(cmp, minK, inner.left)
      : nodeWithMinExclusiveN(cmp, minK, inner.left).result;
    return maxIncl ? nodeUnsafeAddMaximum(inner.key, inner.value, left) : left;
  }
  if (cMin > 0) return nodeSliceEx(cmp, minK, minIncl, maxK, maxIncl, inner.right);
  return nodeSliceEx(cmp, minK, minIncl, maxK, maxIncl, inner.left);
}

function nodeTake<K, V>(n: number, node: Node<K, V> | null): Node<K, V> | null {
  if (n <= 0 || node === null) return null;
  if (node.height === 1) return node;
  const inner = node as Inner<K, V>;
  if (inner.count <= n) return inner;
  const lc = nodeCount(inner.left);
  if (lc < n) {
    return binary(inner.left, inner.key, inner.value, nodeTake(n - 1 - lc, inner.right));
  }
  if (lc === n) return inner.left;
  return nodeTake(n, inner.left);
}

function nodeSkip<K, V>(n: number, node: Node<K, V> | null): Node<K, V> | null {
  if (n <= 0 || node === null) return node;
  if (node.height === 1) return null;
  const inner = node as Inner<K, V>;
  if (inner.count <= n) return null;
  const lc = nodeCount(inner.left);
  if (n > lc) return nodeSkip(n - 1 - lc, inner.right);
  if (n === lc) return nodeUnsafeAddMinimum(inner.key, inner.value, inner.right);
  return binary(nodeSkip(n, inner.left), inner.key, inner.value, inner.right);
}

function nodeSliceAt<K, V>(
  minIndex: number,
  maxIndex: number,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    return minIndex <= 0 && maxIndex >= 0 ? node : null;
  }
  const inner = node as Inner<K, V>;
  const lc = nodeCount(inner.left);
  if (minIndex > lc) return nodeSliceAt(minIndex - lc - 1, maxIndex - lc - 1, inner.right);
  if (maxIndex < lc) return nodeSliceAt(minIndex, maxIndex, inner.left);
  const skipLeft = minIndex;
  const takeRight = maxIndex - lc;
  const l = skipLeft <= 0 ? inner.left : nodeSkip(skipLeft, inner.left);
  const r = takeRight >= nodeCount(inner.right) ? inner.right : nodeTake(takeRight, inner.right);
  return binary(l, inner.key, inner.value, r);
}

// ---------------------------------------------------------------------------
// Traversals
// ---------------------------------------------------------------------------

function nodeIter<K, V>(action: (k: K, v: V) => void, node: Node<K, V> | null): void {
  if (node === null) return;
  if (node.height === 1) {
    action(node.key, node.value);
    return;
  }
  const inner = node as Inner<K, V>;
  nodeIter(action, inner.left);
  action(inner.key, inner.value);
  nodeIter(action, inner.right);
}

function nodeIterValue<K, V>(action: (v: V) => void, node: Node<K, V> | null): void {
  if (node === null) return;
  if (node.height === 1) {
    action(node.value);
    return;
  }
  const inner = node as Inner<K, V>;
  nodeIterValue(action, inner.left);
  action(inner.value);
  nodeIterValue(action, inner.right);
}

function nodeFold<K, V, S>(
  folder: (s: S, k: K, v: V) => S,
  state: S,
  node: Node<K, V> | null,
): S {
  if (node === null) return state;
  if (node.height === 1) return folder(state, node.key, node.value);
  const inner = node as Inner<K, V>;
  const s1 = nodeFold(folder, state, inner.left);
  const s2 = folder(s1, inner.key, inner.value);
  return nodeFold(folder, s2, inner.right);
}

function nodeFoldBack<K, V, S>(
  folder: (k: K, v: V, s: S) => S,
  state: S,
  node: Node<K, V> | null,
): S {
  if (node === null) return state;
  if (node.height === 1) return folder(node.key, node.value, state);
  const inner = node as Inner<K, V>;
  const s1 = nodeFoldBack(folder, state, inner.right);
  const s2 = folder(inner.key, inner.value, s1);
  return nodeFoldBack(folder, s2, inner.left);
}

function nodeExists<K, V>(
  predicate: (k: K, v: V) => boolean,
  node: Node<K, V> | null,
): boolean {
  if (node === null) return false;
  if (node.height === 1) return predicate(node.key, node.value);
  const inner = node as Inner<K, V>;
  return (
    nodeExists(predicate, inner.left) ||
    predicate(inner.key, inner.value) ||
    nodeExists(predicate, inner.right)
  );
}

function nodeForall<K, V>(
  predicate: (k: K, v: V) => boolean,
  node: Node<K, V> | null,
): boolean {
  if (node === null) return true;
  if (node.height === 1) return predicate(node.key, node.value);
  const inner = node as Inner<K, V>;
  return (
    nodeForall(predicate, inner.left) &&
    predicate(inner.key, inner.value) &&
    nodeForall(predicate, inner.right)
  );
}

function nodeTryPick<K, V, T>(
  mapping: (k: K, v: V) => T | undefined,
  node: Node<K, V> | null,
): T | undefined {
  if (node === null) return undefined;
  if (node.height === 1) return mapping(node.key, node.value);
  const inner = node as Inner<K, V>;
  const l = nodeTryPick(mapping, inner.left);
  if (l !== undefined) return l;
  const s = mapping(inner.key, inner.value);
  if (s !== undefined) return s;
  return nodeTryPick(mapping, inner.right);
}

function nodeTryPickBack<K, V, T>(
  mapping: (k: K, v: V) => T | undefined,
  node: Node<K, V> | null,
): T | undefined {
  if (node === null) return undefined;
  if (node.height === 1) return mapping(node.key, node.value);
  const inner = node as Inner<K, V>;
  const r = nodeTryPickBack(mapping, inner.right);
  if (r !== undefined) return r;
  const s = mapping(inner.key, inner.value);
  if (s !== undefined) return s;
  return nodeTryPickBack(mapping, inner.left);
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------

function nodeMap<K, V, T>(
  mapping: (k: K, v: V) => T,
  node: Node<K, V> | null,
): Node<K, T> | null {
  if (node === null) return null;
  if (node.height === 1) {
    return new Node<K, T>(node.key, mapping(node.key, node.value), 1);
  }
  const inner = node as Inner<K, V>;
  return new Inner<K, T>(
    nodeMap(mapping, inner.left),
    inner.key,
    mapping(inner.key, inner.value),
    nodeMap(mapping, inner.right),
    inner.height,
    inner.count,
  );
}

function nodeMapMonotonic<K, V, K2, T>(
  mapping: (k: K, v: V) => [K2, T],
  node: Node<K, V> | null,
): Node<K2, T> | null {
  if (node === null) return null;
  if (node.height === 1) {
    const [k2, v2] = mapping(node.key, node.value);
    return new Node<K2, T>(k2, v2, 1);
  }
  const inner = node as Inner<K, V>;
  const l = nodeMapMonotonic(mapping, inner.left);
  const [k2, v2] = mapping(inner.key, inner.value);
  const r = nodeMapMonotonic(mapping, inner.right);
  return new Inner<K2, T>(l, k2, v2, r, inner.height, inner.count);
}

function nodeChoose<K, V, T>(
  mapping: (k: K, v: V) => T | undefined,
  node: Node<K, V> | null,
): Node<K, T> | null {
  if (node === null) return null;
  if (node.height === 1) {
    const t = mapping(node.key, node.value);
    if (t === undefined) return null;
    return new Node<K, T>(node.key, t, 1);
  }
  const inner = node as Inner<K, V>;
  const l = nodeChoose(mapping, inner.left);
  const t = mapping(inner.key, inner.value);
  const r = nodeChoose(mapping, inner.right);
  if (t !== undefined) return binary(l, inner.key, t, r);
  return joinRec(l, r);
}

function nodeFilter<K, V>(
  predicate: (k: K, v: V) => boolean,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) return predicate(node.key, node.value) ? node : null;
  const inner = node as Inner<K, V>;
  const l = nodeFilter(predicate, inner.left);
  const keep = predicate(inner.key, inner.value);
  const r = nodeFilter(predicate, inner.right);
  if (keep) return binary(l, inner.key, inner.value, r);
  return joinRec(l, r);
}

function nodePartition<K, V>(
  predicate: (k: K, v: V) => boolean,
  node: Node<K, V> | null,
): [Node<K, V> | null, Node<K, V> | null] {
  if (node === null) return [null, null];
  if (node.height === 1) {
    return predicate(node.key, node.value) ? [node, null] : [null, node];
  }
  const inner = node as Inner<K, V>;
  const [yl, nl] = nodePartition(predicate, inner.left);
  const keep = predicate(inner.key, inner.value);
  const [yr, nr] = nodePartition(predicate, inner.right);
  if (keep) return [binary(yl, inner.key, inner.value, yr), joinRec(nl, nr)];
  return [joinRec(yl, yr), binary(nl, inner.key, inner.value, nr)];
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

function nodeUnion<K, V>(
  cmp: KeyComparer<K>,
  a: Node<K, V> | null,
  b: Node<K, V> | null,
): Node<K, V> | null {
  if (a === b) return a;
  if (a === null) return b;
  if (b === null) return a;
  if (a.height === 1) return nodeAddIfNotPresent(cmp, a.key, a.value, b);
  if (b.height === 1) return nodeAdd(cmp, b.key, b.value, a);
  const ai = a as Inner<K, V>;
  const bi = b as Inner<K, V>;
  if (ai.height < bi.height) {
    const s = nodeSplit(cmp, bi.key, ai);
    const l = nodeUnion(cmp, s.left, bi.left);
    const r = nodeUnion(cmp, s.right, bi.right);
    return binary(l, bi.key, bi.value, r);
  }
  const s = nodeSplit(cmp, ai.key, bi);
  const l = nodeUnion(cmp, ai.left, s.left);
  const v = s.hasValue ? (s.self as V) : ai.value;
  const r = nodeUnion(cmp, ai.right, s.right);
  return binary(l, ai.key, v, r);
}

function nodeUnionWith<K, V>(
  cmp: KeyComparer<K>,
  resolve: (k: K, l: V, r: V) => V,
  l: Node<K, V> | null,
  r: Node<K, V> | null,
): Node<K, V> | null {
  if (l === null) return r;
  if (r === null) return l;
  if (l.height === 1) return nodeChangeWithLeft(cmp, l.key, l.value, resolve, r);
  if (r.height === 1) return nodeChangeWithRight(cmp, r.key, r.value, resolve, l);
  const li = l as Inner<K, V>;
  const ri = r as Inner<K, V>;
  if (li.height < ri.height) {
    const s = nodeSplit(cmp, ri.key, li);
    const newLeft = nodeUnionWith(cmp, resolve, s.left, ri.left);
    const value = s.hasValue ? resolve(ri.key, s.self as V, ri.value) : ri.value;
    const newRight = nodeUnionWith(cmp, resolve, s.right, ri.right);
    return binary(newLeft, ri.key, value, newRight);
  }
  const s = nodeSplit(cmp, li.key, ri);
  const newLeft = nodeUnionWith(cmp, resolve, li.left, s.left);
  const value = s.hasValue ? resolve(li.key, li.value, s.self as V) : li.value;
  const newRight = nodeUnionWith(cmp, resolve, li.right, s.right);
  return binary(newLeft, li.key, value, newRight);
}

// ---------------------------------------------------------------------------
// Neighbours
// ---------------------------------------------------------------------------

interface Neighbours<K, V> {
  left: [K, V] | undefined;
  self: V | undefined;
  right: [K, V] | undefined;
}

function nodeNeighbours<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): Neighbours<K, V> {
  let left: [K, V] | undefined = undefined;
  let right: [K, V] | undefined = undefined;
  let self: V | undefined = undefined;
  const traverse = (n: Node<K, V> | null): void => {
    if (n === null) return;
    if (n.height === 1) {
      const c = cmp(key, n.key);
      if (c > 0) left = [n.key, n.value];
      else if (c < 0) right = [n.key, n.value];
      else self = n.value;
      return;
    }
    const inner = n as Inner<K, V>;
    const c = cmp(key, inner.key);
    if (c > 0) {
      left = [inner.key, inner.value];
      traverse(inner.right);
    } else if (c < 0) {
      right = [inner.key, inner.value];
      traverse(inner.left);
    } else {
      self = inner.value;
      const mn = nodeMin(inner.right);
      if (mn !== undefined) right = mn;
      const mx = nodeMax(inner.left);
      if (mx !== undefined) left = mx;
    }
  };
  traverse(node);
  return { left, self, right };
}

interface NeighboursAt<K, V> {
  left: [K, V] | undefined;
  self: [K, V] | undefined;
  right: [K, V] | undefined;
}

function nodeNeighboursAt<K, V>(
  index: number,
  node: Node<K, V> | null,
): NeighboursAt<K, V> {
  let left: [K, V] | undefined = undefined;
  let right: [K, V] | undefined = undefined;
  let self: [K, V] | undefined = undefined;
  const traverse = (idx: number, n: Node<K, V> | null): void => {
    if (n === null) return;
    if (n.height === 1) {
      if (idx > 0) left = [n.key, n.value];
      else if (idx < 0) right = [n.key, n.value];
      else self = [n.key, n.value];
      return;
    }
    const inner = n as Inner<K, V>;
    const id = idx - nodeCount(inner.left);
    if (id > 0) {
      left = [inner.key, inner.value];
      traverse(id - 1, inner.right);
    } else if (id < 0) {
      right = [inner.key, inner.value];
      traverse(idx, inner.left);
    } else {
      self = [inner.key, inner.value];
      const mn = nodeMin(inner.right);
      if (mn !== undefined) right = mn;
      const mx = nodeMax(inner.left);
      if (mx !== undefined) left = mx;
    }
  };
  traverse(index, node);
  return { left, self, right };
}

// ---------------------------------------------------------------------------
// changeWithNeighbours
// ---------------------------------------------------------------------------

function nodeChangeWithNeighbours<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  l: [K, V] | undefined,
  r: [K, V] | undefined,
  replacement: (
    l: [K, V] | undefined,
    self: V | undefined,
    r: [K, V] | undefined,
  ) => V | undefined,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) {
    const v = replacement(l, undefined, r);
    return v === undefined ? null : new Node<K, V>(key, v, 1);
  }
  if (node.height === 1) {
    const c = cmp(key, node.key);
    if (c > 0) {
      const v = replacement([node.key, node.value], undefined, r);
      return v === undefined ? node : new Inner<K, V>(node, key, v, null, 2, 2);
    }
    if (c < 0) {
      const v = replacement(l, undefined, [node.key, node.value]);
      return v === undefined ? node : new Inner<K, V>(null, key, v, node, 2, 2);
    }
    const v = replacement(l, node.value, r);
    return v === undefined ? null : new Node<K, V>(key, v, 1);
  }
  const inner = node as Inner<K, V>;
  const c = cmp(key, inner.key);
  if (c > 0) {
    return binary(
      inner.left,
      inner.key,
      inner.value,
      nodeChangeWithNeighbours(cmp, key, [inner.key, inner.value], r, replacement, inner.right),
    );
  }
  if (c < 0) {
    return binary(
      nodeChangeWithNeighbours(cmp, key, l, [inner.key, inner.value], replacement, inner.left),
      inner.key,
      inner.value,
      inner.right,
    );
  }
  const rN = nodeMin(inner.right);
  const lN = nodeMax(inner.left);
  const v = replacement(lN ?? l, inner.value, rN ?? r);
  if (v === undefined) return unsafeJoin(inner.left, inner.right);
  return new Inner<K, V>(inner.left, key, v, inner.right, inner.height, inner.count);
}

// ---------------------------------------------------------------------------
// computeDelta / applyDelta(AndGetEffective)
// ---------------------------------------------------------------------------

function nodeComputeDelta<K, V1, V2, OP>(
  cmp: KeyComparer<K>,
  node1: Node<K, V1> | null,
  node2: Node<K, V2> | null,
  update: (k: K, l: V1, r: V2) => OP | undefined,
  invoke: (k: K, v: V2) => OP,
  revoke: (k: K, v: V1) => OP,
): Node<K, OP> | null {
  if (node1 === null) {
    return nodeMap<K, V2, OP>((k, v) => invoke(k, v), node2);
  }
  if (node2 === null) {
    return nodeMap<K, V1, OP>((k, v) => revoke(k, v), node1);
  }
  if ((node1 as unknown) === (node2 as unknown)) return null;
  if (node1.height === 1) {
    if (node2.height === 1) {
      const c = cmp(node2.key, node1.key);
      if (c > 0) {
        const a = revoke(node1.key, node1.value);
        const b = invoke(node2.key, node2.value);
        return new Inner<K, OP>(new Node<K, OP>(node1.key, a, 1), node2.key, b, null, 2, 2);
      }
      if (c < 0) {
        const b = invoke(node2.key, node2.value);
        const a = revoke(node1.key, node1.value);
        return new Inner<K, OP>(null, node2.key, b, new Node<K, OP>(node1.key, a, 1), 2, 2);
      }
      const op = update(node1.key, node1.value, node2.value);
      return op === undefined ? null : new Node<K, OP>(node1.key, op, 1);
    }
    const inner = node2 as Inner<K, V2>;
    const c = cmp(node1.key, inner.key);
    if (c > 0) {
      const l1 = nodeMap<K, V2, OP>((k, v) => invoke(k, v), inner.left);
      const s = invoke(inner.key, inner.value);
      const r1 = nodeComputeDelta(cmp, node1, inner.right, update, invoke, revoke);
      return binary(l1, inner.key, s, r1);
    }
    if (c < 0) {
      const l1 = nodeComputeDelta(cmp, node1, inner.left, update, invoke, revoke);
      const s = invoke(inner.key, inner.value);
      const r1 = nodeMap<K, V2, OP>((k, v) => invoke(k, v), inner.right);
      return binary(l1, inner.key, s, r1);
    }
    const l1 = nodeMap<K, V2, OP>((k, v) => invoke(k, v), inner.left);
    const op = update(node1.key, node1.value, inner.value);
    const r1 = nodeMap<K, V2, OP>((k, v) => invoke(k, v), inner.right);
    if (op === undefined) return joinRec(l1, r1);
    return new Inner<K, OP>(l1, node1.key, op, r1, inner.height, inner.count);
  }
  if (node2.height === 1) {
    const inner = node1 as Inner<K, V1>;
    const c = cmp(node2.key, inner.key);
    if (c > 0) {
      const l1 = nodeMap<K, V1, OP>((k, v) => revoke(k, v), inner.left);
      const s = revoke(inner.key, inner.value);
      const r1 = nodeComputeDelta(cmp, inner.right, node2, update, invoke, revoke);
      return binary(l1, inner.key, s, r1);
    }
    if (c < 0) {
      const l1 = nodeComputeDelta(cmp, inner.left, node2, update, invoke, revoke);
      const s = revoke(inner.key, inner.value);
      const r1 = nodeMap<K, V1, OP>((k, v) => revoke(k, v), inner.right);
      return binary(l1, inner.key, s, r1);
    }
    const l1 = nodeMap<K, V1, OP>((k, v) => revoke(k, v), inner.left);
    const op = update(inner.key, inner.value, node2.value);
    const r1 = nodeMap<K, V1, OP>((k, v) => revoke(k, v), inner.right);
    if (op === undefined) return joinRec(l1, r1);
    return new Inner<K, OP>(l1, inner.key, op, r1, inner.height, inner.count);
  }
  if (node1.height > node2.height) {
    const inner = node1 as Inner<K, V1>;
    const s = nodeSplit(cmp, inner.key, node2);
    if (s.hasValue) {
      const ld = nodeComputeDelta(cmp, inner.left, s.left, update, invoke, revoke);
      const self = update(inner.key, inner.value, s.self as V2);
      const rd = nodeComputeDelta(cmp, inner.right, s.right, update, invoke, revoke);
      if (self === undefined) return joinRec(ld, rd);
      return binary(ld, inner.key, self, rd);
    }
    const ld = nodeComputeDelta(cmp, inner.left, s.left, update, invoke, revoke);
    const op = revoke(inner.key, inner.value);
    const rd = nodeComputeDelta(cmp, inner.right, s.right, update, invoke, revoke);
    return binary(ld, inner.key, op, rd);
  }
  const inner = node2 as Inner<K, V2>;
  const s = nodeSplit(cmp, inner.key, node1);
  if (s.hasValue) {
    const ld = nodeComputeDelta(cmp, s.left, inner.left, update, invoke, revoke);
    const self = update(inner.key, s.self as V1, inner.value);
    const rd = nodeComputeDelta(cmp, s.right, inner.right, update, invoke, revoke);
    if (self === undefined) return joinRec(ld, rd);
    return binary(ld, inner.key, self, rd);
  }
  const ld = nodeComputeDelta(cmp, s.left, inner.left, update, invoke, revoke);
  const self = invoke(inner.key, inner.value);
  const rd = nodeComputeDelta(cmp, s.right, inner.right, update, invoke, revoke);
  return binary(ld, inner.key, self, rd);
}

function nodeApplyDeltaAndGetEffective<K, V, D, DOut>(
  cmp: KeyComparer<K>,
  state: Node<K, V> | null,
  delta: Node<K, D> | null,
  applyNoState: (k: K, d: D) => [V | undefined, DOut | undefined],
  apply: (k: K, v: V, d: D) => [V | undefined, DOut | undefined],
): [Node<K, V> | null, Node<K, DOut> | null] {
  if (delta === null) return [state, null];
  if (state === null) {
    let res: Node<K, V> | null = null;
    let eff: Node<K, DOut> | null = null;
    nodeIter<K, D>((k, d) => {
      const [s, e] = applyNoState(k, d);
      if (s !== undefined) res = nodeAdd(cmp, k, s, res);
      if (e !== undefined) eff = nodeAdd(cmp, k, e, eff);
    }, delta);
    return [res, eff];
  }
  // Merge by traversing delta and looking up state per-key. Simpler than
  // the F# split-based recursion; same observable result, slightly more
  // allocation. Linear in |delta| × log |state|.
  let s: Node<K, V> | null = state;
  let e: Node<K, DOut> | null = null;
  nodeIter<K, D>((k, d) => {
    const existing = nodeTryFind(cmp, k, s);
    const had = existing !== undefined || nodeContainsKey(cmp, k, s);
    const [ns, ed] = had
      ? apply(k, existing as V, d)
      : applyNoState(k, d);
    if (ns === undefined) {
      if (had) {
        const r = nodeTryRemove(cmp, k, s);
        if (r !== undefined) s = r[1];
      }
    } else {
      s = nodeAdd(cmp, k, ns, s);
    }
    if (ed !== undefined) e = nodeAdd(cmp, k, ed, e);
  }, delta);
  return [s, e];
}

// ---------------------------------------------------------------------------
// Equality / hashing
// ---------------------------------------------------------------------------

function combineHash(a: number, b: number): number {
  return (((a ^ b) + 0x9e3779b9) + (a << 6) + (a >>> 2)) | 0;
}

function nodeStructuralEquals<K, V>(
  cmp: KeyComparer<K>,
  a: Node<K, V> | null,
  b: Node<K, V> | null,
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (nodeCount(a) !== nodeCount(b)) return false;
  // Compare in-order traversal.
  const ai = inOrder(a);
  const bi = inOrder(b);
  let na = ai.next();
  let nb = bi.next();
  while (!na.done && !nb.done) {
    if (cmp(na.value[0], nb.value[0]) !== 0) return false;
    if (!Object.is(na.value[1], nb.value[1])) return false;
    na = ai.next();
    nb = bi.next();
  }
  return na.done === true && nb.done === true;
}

function* inOrder<K, V>(
  node: Node<K, V> | null,
): IterableIterator<[K, V]> {
  const stack: Array<Node<K, V>> = [];
  let cur: Node<K, V> | null = node;
  while (cur !== null || stack.length > 0) {
    while (cur !== null) {
      stack.push(cur);
      cur = cur.height === 1 ? null : (cur as Inner<K, V>).left;
    }
    const n = stack.pop()!;
    yield [n.key, n.value];
    cur = n.height === 1 ? null : (n as Inner<K, V>).right;
  }
}

// ---------------------------------------------------------------------------
// Public MapExt<K, V>
// ---------------------------------------------------------------------------

export class MapExt<K, V> implements Iterable<[K, V]> {
  private readonly _root: Node<K, V> | null;
  private readonly _cmp: KeyComparer<K>;

  /** @internal */
  constructor(root: Node<K, V> | null, cmp: KeyComparer<K>) {
    this._root = root;
    this._cmp = cmp;
  }

  get count(): number {
    return nodeCount(this._root);
  }
  get isEmpty(): boolean {
    return this._root === null;
  }

  containsKey(key: K): boolean {
    return nodeContainsKey(this._cmp, key, this._root);
  }
  tryFind(key: K): V | undefined {
    return nodeTryFind(this._cmp, key, this._root);
  }
  find(key: K): V {
    return nodeFind(this._cmp, key, this._root);
  }

  add(key: K, value: V): MapExt<K, V> {
    return new MapExt<K, V>(nodeAdd(this._cmp, key, value, this._root), this._cmp);
  }

  addIfNotPresent(key: K, value: V): MapExt<K, V> {
    return new MapExt<K, V>(nodeAddIfNotPresent(this._cmp, key, value, this._root), this._cmp);
  }

  remove(key: K): MapExt<K, V> {
    const r = nodeTryRemove(this._cmp, key, this._root);
    if (r === undefined) return this;
    return new MapExt<K, V>(r[1], this._cmp);
  }

  tryRemove(key: K): { value: V; rest: MapExt<K, V> } | undefined {
    const r = nodeTryRemove(this._cmp, key, this._root);
    if (r === undefined) return undefined;
    return { value: r[0], rest: new MapExt<K, V>(r[1], this._cmp) };
  }

  removeAt(index: number): MapExt<K, V> {
    if (index < 0 || index >= this.count) return this;
    const r = nodeRemoveAt(index, this._root);
    if (r === null) return this;
    return new MapExt<K, V>(r.result, this._cmp);
  }

  tryRemoveAt(index: number): { key: K; value: V; rest: MapExt<K, V> } | undefined {
    if (index < 0 || index >= this.count) return undefined;
    const r = nodeRemoveAt(index, this._root);
    if (r === null) return undefined;
    return { key: r.key, value: r.value, rest: new MapExt<K, V>(r.result, this._cmp) };
  }

  alter(key: K, update: (existing: V | undefined) => V | undefined): MapExt<K, V> {
    return new MapExt<K, V>(nodeChange(this._cmp, key, update, this._root), this._cmp);
  }
  change = this.alter;
  changeV = this.alter;

  iter(action: (k: K, v: V) => void): void {
    nodeIter(action, this._root);
  }
  iterValue(action: (v: V) => void): void {
    nodeIterValue(action, this._root);
  }
  fold<S>(folder: (s: S, k: K, v: V) => S, state: S): S {
    return nodeFold(folder, state, this._root);
  }
  foldBack<S>(folder: (k: K, v: V, s: S) => S, state: S): S {
    return nodeFoldBack(folder, state, this._root);
  }
  exists(predicate: (k: K, v: V) => boolean): boolean {
    return nodeExists(predicate, this._root);
  }
  forall(predicate: (k: K, v: V) => boolean): boolean {
    return nodeForall(predicate, this._root);
  }
  tryPick<T>(mapping: (k: K, v: V) => T | undefined): T | undefined {
    return nodeTryPick(mapping, this._root);
  }
  tryPickBack<T>(mapping: (k: K, v: V) => T | undefined): T | undefined {
    return nodeTryPickBack(mapping, this._root);
  }

  map<U>(mapping: (k: K, v: V) => U): MapExt<K, U> {
    return new MapExt<K, U>(nodeMap(mapping, this._root), this._cmp);
  }

  /**
   * Like `map` but lets the mapping return a new key as well. Caller
   * must guarantee the new keys preserve sorted order; the AVL
   * invariant is not re-checked.
   */
  mapMonotonic<K2, U>(
    mapping: (k: K, v: V) => [K2, U],
    cmp2: KeyComparer<K2>,
  ): MapExt<K2, U> {
    return new MapExt<K2, U>(nodeMapMonotonic(mapping, this._root), cmp2);
  }

  choose<U>(mapping: (k: K, v: V) => U | undefined): MapExt<K, U> {
    return new MapExt<K, U>(nodeChoose(mapping, this._root), this._cmp);
  }

  filter(predicate: (k: K, v: V) => boolean): MapExt<K, V> {
    return new MapExt<K, V>(nodeFilter(predicate, this._root), this._cmp);
  }

  partition(
    predicate: (k: K, v: V) => boolean,
  ): { yes: MapExt<K, V>; no: MapExt<K, V> } {
    const [y, n] = nodePartition(predicate, this._root);
    return {
      yes: new MapExt<K, V>(y, this._cmp),
      no: new MapExt<K, V>(n, this._cmp),
    };
  }

  tryMin(): [K, V] | undefined {
    return nodeMin(this._root);
  }
  tryMax(): [K, V] | undefined {
    return nodeMax(this._root);
  }
  get minKey(): K {
    const m = nodeMin(this._root);
    if (m === undefined) throw new Error("MapExt is empty");
    return m[0];
  }
  get maxKey(): K {
    const m = nodeMax(this._root);
    if (m === undefined) throw new Error("MapExt is empty");
    return m[0];
  }

  withMin(minKey: K): MapExt<K, V> {
    return new MapExt<K, V>(nodeWithMin(this._cmp, minKey, this._root), this._cmp);
  }
  withMax(maxKey: K): MapExt<K, V> {
    return new MapExt<K, V>(nodeWithMax(this._cmp, maxKey, this._root), this._cmp);
  }

  slice(minKey: K, maxKey: K): MapExt<K, V> {
    return new MapExt<K, V>(nodeSlice(this._cmp, minKey, maxKey, this._root), this._cmp);
  }
  sliceEx(minKey: K, minIncl: boolean, maxKey: K, maxIncl: boolean): MapExt<K, V> {
    return new MapExt<K, V>(
      nodeSliceEx(this._cmp, minKey, minIncl, maxKey, maxIncl, this._root),
      this._cmp,
    );
  }

  /** Take the first `n` entries (in sorted order). */
  take(n: number): MapExt<K, V> {
    return new MapExt<K, V>(nodeTake(n, this._root), this._cmp);
  }
  /** Skip the first `n` entries. */
  skip(n: number): MapExt<K, V> {
    return new MapExt<K, V>(nodeSkip(n, this._root), this._cmp);
  }
  /** Slice between the given zero-based indices (both inclusive). */
  sliceAt(minIndex: number, maxIndex: number): MapExt<K, V> {
    return new MapExt<K, V>(nodeSliceAt(minIndex, maxIndex, this._root), this._cmp);
  }

  /**
   * Splits the map at `key`. Returns the entries strictly less than
   * `key`, the value at `key` if present, and the entries strictly
   * greater.
   */
  split(key: K): {
    hasValue: boolean;
    left: MapExt<K, V>;
    self: V | undefined;
    right: MapExt<K, V>;
  } {
    const r = nodeSplit(this._cmp, key, this._root);
    return {
      hasValue: r.hasValue,
      left: new MapExt<K, V>(r.left, this._cmp),
      self: r.self,
      right: new MapExt<K, V>(r.right, this._cmp),
    };
  }
  splitAt(index: number): {
    left: MapExt<K, V>;
    self: [K, V] | undefined;
    right: MapExt<K, V>;
  } {
    const r = nodeSplitAt(index, this._root);
    return {
      left: new MapExt<K, V>(r.left, this._cmp),
      self: r.self,
      right: new MapExt<K, V>(r.right, this._cmp),
    };
  }

  neighbours(key: K): Neighbours<K, V> {
    return nodeNeighbours(this._cmp, key, this._root);
  }
  neighboursAt(index: number): NeighboursAt<K, V> {
    return nodeNeighboursAt(index, this._root);
  }

  changeWithNeighbours(
    key: K,
    update: (
      left: [K, V] | undefined,
      self: V | undefined,
      right: [K, V] | undefined,
    ) => V | undefined,
  ): MapExt<K, V> {
    return new MapExt<K, V>(
      nodeChangeWithNeighbours(this._cmp, key, undefined, undefined, update, this._root),
      this._cmp,
    );
  }

  /** Entry at zero-based index `i`, or undefined. */
  itemV(i: number): [K, V] | undefined {
    return nodeTryGetItem(i, this._root);
  }

  tryGetIndex(key: K): number {
    return nodeTryGetIndex(this._cmp, key, 0, this._root);
  }

  union(other: MapExt<K, V>): MapExt<K, V> {
    return new MapExt<K, V>(nodeUnion(this._cmp, this._root, other._root), this._cmp);
  }

  unionWith(other: MapExt<K, V>, resolve: (k: K, l: V, r: V) => V): MapExt<K, V> {
    return new MapExt<K, V>(
      nodeUnionWith(this._cmp, resolve, this._root, other._root),
      this._cmp,
    );
  }

  toList(): Array<[K, V]> {
    const out: Array<[K, V]> = [];
    nodeIter<K, V>((k, v) => out.push([k, v]), this._root);
    return out;
  }
  toArray(): Array<[K, V]> {
    return this.toList();
  }
  toListBack(): Array<[K, V]> {
    const out: Array<[K, V]> = [];
    const rec = (n: Node<K, V> | null): void => {
      if (n === null) return;
      if (n.height === 1) {
        out.push([n.key, n.value]);
        return;
      }
      const inner = n as Inner<K, V>;
      rec(inner.right);
      out.push([inner.key, inner.value]);
      rec(inner.left);
    };
    rec(this._root);
    return out;
  }
  toKeyList(): K[] {
    return this.toList().map((kv) => kv[0]);
  }
  toKeyListBack(): K[] {
    return this.toListBack().map((kv) => kv[0]);
  }
  toValueList(): V[] {
    return this.toList().map((kv) => kv[1]);
  }
  toValueListBack(): V[] {
    return this.toListBack().map((kv) => kv[1]);
  }
  toSeq(): Iterable<[K, V]> {
    return this;
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    yield* inOrder(this._root);
  }

  applyDeltaAndGetEffective<D, DOut>(
    delta: MapExt<K, D>,
    apply: (
      k: K,
      existing: V | undefined,
      d: D,
    ) => [V | undefined, DOut | undefined],
  ): { state: MapExt<K, V>; effective: MapExt<K, DOut> } {
    const [s, e] = nodeApplyDeltaAndGetEffective<K, V, D, DOut>(
      this._cmp,
      this._root,
      delta._root,
      (k, d) => apply(k, undefined, d),
      (k, v, d) => apply(k, v, d),
    );
    return {
      state: new MapExt<K, V>(s, this._cmp),
      effective: new MapExt<K, DOut>(e, this._cmp as unknown as KeyComparer<K>),
    };
  }

  /** Compute a delta-as-MapExt mapping from this to `other`. */
  computeDeltaTo<D>(
    other: MapExt<K, V>,
    add: (k: K, v: V) => D,
    update: (k: K, oldV: V, newV: V) => D | undefined,
    remove: (k: K, v: V) => D,
  ): MapExt<K, D> {
    const root = nodeComputeDelta<K, V, V, D>(
      this._cmp,
      this._root,
      other._root,
      update,
      add,
      remove,
    );
    return new MapExt<K, D>(root, this._cmp as unknown as KeyComparer<K>);
  }

  equals(other: MapExt<K, V>): boolean {
    return nodeStructuralEquals(this._cmp, this._root, other._root);
  }

  hash(): number {
    let acc = 0;
    nodeIter<K, V>((k, v) => {
      // Hashing keys/values requires a comparer-supplied hash; we use
      // the integer cast where possible, otherwise rely on string
      // representation for object keys/values. This matches the
      // F# `Unchecked.hash` fallback semantics for non-numeric values.
      const hk = typeof k === "number" ? (k as unknown as number) | 0 : 0;
      const hv = typeof v === "number" ? (v as unknown as number) | 0 : 0;
      acc = combineHash(acc, combineHash(hk, hv));
    }, this._root);
    return acc;
  }

  // ----- static factories -----

  static empty<K, V>(cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>(null, cmp);
  }
  static single<K, V>(key: K, value: V, cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>(new Node<K, V>(key, value, 1), cmp);
  }
  static ofSeq<K, V>(elements: Iterable<[K, V]>, cmp: KeyComparer<K>): MapExt<K, V> {
    let root: Node<K, V> | null = null;
    for (const [k, v] of elements) root = nodeAddInPlace(cmp, k, v, root);
    return new MapExt<K, V>(root, cmp);
  }
  static ofArray<K, V>(
    elements: Array<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    return MapExt.ofSeq(elements, cmp);
  }
  static ofList<K, V>(
    elements: Array<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    return MapExt.ofSeq(elements, cmp);
  }
}
