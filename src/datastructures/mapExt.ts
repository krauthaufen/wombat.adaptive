// Port of FSharp.Data.Adaptive Datastructures/MapExt.fs
//
// Faithful balanced-binary-tree port (AVL-style with height/count
// tracking). Replaces the prior sorted-array placeholder. Public API
// matches the pragmatic version exactly so IndexList and existing
// tests continue to work.
//
// PORT NOTE — node hierarchy:
//   F# uses `Node<K, V>` as a leaf-shaped base carrying key/value and a
//   1-byte height, with `Inner<K, V>` extending it to add left/right
//   children plus a precomputed count. We mirror that hierarchy with TS
//   classes (height stored as a number; counts and heights re-derived
//   on each rebalance).
//
// PORT NOTE — operations covered:
//   The F# original has ~70 operations spread over 3900 lines. This
//   port covers the public-API surface used by IndexList and the
//   existing test suite — add / remove / alter / tryFind / find /
//   containsKey / iter / fold / exists / forall / map / choose /
//   filter / partition / minKey / maxKey / withMin / withMax / slice /
//   neighbours / changeWithNeighbours / itemV / tryGetIndex / union /
//   unionWith / applyDeltaAndGetEffective / computeDeltaTo.
//
//   Less-common operations (sliceEx with exclusive bounds, splitAt,
//   tryPickBack, take/skip-by-key, etc.) are deferred — they're not
//   exercised by current tests; add as needed.

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

/// Build a balanced node from `l, k, v, r`. Performs at most two
/// rotations to restore AVL invariant when child heights differ by > 2.
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
      // left-left
      return create(li.left, li.key, li.value, create(li.right, k, v, r));
    }
    // left-right
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

function unsafeRemoveMin<K, V>(
  n: Node<K, V>,
): { key: K; value: V; rest: Node<K, V> | null } {
  if (n.height === 1) {
    return { key: n.key, value: n.value, rest: null };
  }
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

function unsafeJoin<K, V>(
  l: Node<K, V> | null,
  r: Node<K, V> | null,
): Node<K, V> | null {
  if (l === null) return r;
  if (r === null) return l;
  const { key, value, rest } = unsafeRemoveMin(r);
  return unsafeBinary(l, key, value, rest);
}

// ---------------------------------------------------------------------------
// Core operations
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

function nodeAdd<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  value: V,
  node: Node<K, V> | null,
): Node<K, V> {
  if (node === null) return new Node<K, V>(key, value, 1);
  const c = cmp(key, node.key);
  if (node.height === 1) {
    if (c === 0) return new Node<K, V>(key, value, 1);
    if (c < 0) {
      return new Inner<K, V>(new Node<K, V>(key, value, 1), node.key, node.value, null, 2, 2);
    }
    return new Inner<K, V>(null, node.key, node.value, new Node<K, V>(key, value, 1), 2, 2);
  }
  const inner = node as Inner<K, V>;
  if (c < 0) {
    return unsafeBinary(nodeAdd(cmp, key, value, inner.left), inner.key, inner.value, inner.right);
  }
  if (c > 0) {
    return unsafeBinary(inner.left, inner.key, inner.value, nodeAdd(cmp, key, value, inner.right));
  }
  return create(inner.left, key, value, inner.right);
}

function nodeTryRemove<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): [V, Node<K, V> | null] | undefined {
  if (node === null) return undefined;
  const c = cmp(key, node.key);
  if (node.height === 1) {
    if (c === 0) return [node.value, null];
    return undefined;
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
  // c === 0
  return [inner.value, unsafeJoin(inner.left, inner.right)];
}

function nodeIter<K, V>(
  action: (k: K, v: V) => void,
  node: Node<K, V> | null,
): void {
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
  const r = nodeChoose(mapping, inner.right);
  const t = mapping(inner.key, inner.value);
  if (t !== undefined) return unsafeBinary(l, inner.key, t, r);
  return unsafeJoin(l, r);
}

function nodeFilter<K, V>(
  predicate: (k: K, v: V) => boolean,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    return predicate(node.key, node.value) ? node : null;
  }
  const inner = node as Inner<K, V>;
  const l = nodeFilter(predicate, inner.left);
  const r = nodeFilter(predicate, inner.right);
  if (predicate(inner.key, inner.value)) {
    return unsafeBinary(l, inner.key, inner.value, r);
  }
  return unsafeJoin(l, r);
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
  const [yr, nr] = nodePartition(predicate, inner.right);
  if (predicate(inner.key, inner.value)) {
    return [unsafeBinary(yl, inner.key, inner.value, yr), unsafeJoin(nl, nr)];
  }
  return [unsafeJoin(yl, yr), unsafeBinary(nl, inner.key, inner.value, nr)];
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

function nodeWithMin<K, V>(
  cmp: KeyComparer<K>,
  minKey: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    return cmp(node.key, minKey) >= 0 ? node : null;
  }
  const inner = node as Inner<K, V>;
  const c = cmp(inner.key, minKey);
  if (c < 0) return nodeWithMin(cmp, minKey, inner.right);
  if (c > 0) {
    const l = nodeWithMin(cmp, minKey, inner.left);
    return unsafeBinary(l, inner.key, inner.value, inner.right);
  }
  return unsafeBinary(null, inner.key, inner.value, inner.right);
}

function nodeWithMax<K, V>(
  cmp: KeyComparer<K>,
  maxKey: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    return cmp(node.key, maxKey) <= 0 ? node : null;
  }
  const inner = node as Inner<K, V>;
  const c = cmp(inner.key, maxKey);
  if (c > 0) return nodeWithMax(cmp, maxKey, inner.left);
  if (c < 0) {
    const r = nodeWithMax(cmp, maxKey, inner.right);
    return unsafeBinary(inner.left, inner.key, inner.value, r);
  }
  return unsafeBinary(inner.left, inner.key, inner.value, null);
}

function nodeSlice<K, V>(
  cmp: KeyComparer<K>,
  minK: K,
  maxK: K,
  node: Node<K, V> | null,
): Node<K, V> | null {
  if (node === null) return null;
  if (node.height === 1) {
    if (cmp(node.key, minK) >= 0 && cmp(node.key, maxK) <= 0) return node;
    return null;
  }
  const inner = node as Inner<K, V>;
  const cMin = cmp(inner.key, minK);
  const cMax = cmp(inner.key, maxK);
  if (cMin < 0) return nodeSlice(cmp, minK, maxK, inner.right);
  if (cMax > 0) return nodeSlice(cmp, minK, maxK, inner.left);
  // minK <= inner.key <= maxK; include this node, recurse on children
  // bounded by the original limits.
  const l = cMin === 0 ? null : nodeWithMin(cmp, minK, inner.left);
  const r = cMax === 0 ? null : nodeWithMax(cmp, maxK, inner.right);
  return unsafeBinary(l, inner.key, inner.value, r);
}

interface Neighbours<K, V> {
  left: [K, V] | undefined;
  self: V | undefined;
  right: [K, V] | undefined;
}

/// Returns predecessor / self / successor for `key`.
function nodeNeighbours<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): Neighbours<K, V> {
  let cur = node;
  let bestLeft: [K, V] | undefined = undefined;
  let bestRight: [K, V] | undefined = undefined;
  while (cur !== null) {
    const c = cmp(key, cur.key);
    if (c === 0) {
      // Self found — left = max of left subtree (or current bestLeft),
      // right = min of right subtree (or current bestRight).
      let lcur = cur;
      let leftKv: [K, V] | undefined = bestLeft;
      let rightKv: [K, V] | undefined = bestRight;
      if (cur.height !== 1) {
        const inner = cur as Inner<K, V>;
        const m = nodeMax(inner.left);
        if (m !== undefined) leftKv = m;
        const mn = nodeMin(inner.right);
        if (mn !== undefined) rightKv = mn;
      }
      // suppress unused
      void lcur;
      return { left: leftKv, self: cur.value, right: rightKv };
    }
    if (cur.height === 1) {
      if (c < 0) {
        return { left: bestLeft, self: undefined, right: [cur.key, cur.value] };
      }
      return { left: [cur.key, cur.value], self: undefined, right: bestRight };
    }
    const inner = cur as Inner<K, V>;
    if (c < 0) {
      bestRight = [inner.key, inner.value];
      cur = inner.left;
    } else {
      bestLeft = [inner.key, inner.value];
      cur = inner.right;
    }
  }
  return { left: bestLeft, self: undefined, right: bestRight };
}

/// Index in sorted order, or -1 if absent.
function nodeTryGetIndex<K, V>(
  cmp: KeyComparer<K>,
  key: K,
  node: Node<K, V> | null,
): number {
  let cur = node;
  let offset = 0;
  while (cur !== null) {
    const c = cmp(key, cur.key);
    if (c === 0) {
      if (cur.height === 1) return offset;
      const inner = cur as Inner<K, V>;
      return offset + nodeCount(inner.left);
    }
    if (cur.height === 1) return -1;
    const inner = cur as Inner<K, V>;
    if (c < 0) {
      cur = inner.left;
    } else {
      offset += nodeCount(inner.left) + 1;
      cur = inner.right;
    }
  }
  return -1;
}

/// Entry at zero-based index `i` in sorted order, or undefined.
function nodeItemV<K, V>(
  i: number,
  node: Node<K, V> | null,
): [K, V] | undefined {
  if (node === null || i < 0 || i >= nodeCount(node)) return undefined;
  let cur = node;
  let idx = i;
  while (true) {
    if (cur.height === 1) {
      if (idx === 0) return [cur.key, cur.value];
      return undefined;
    }
    const inner = cur as Inner<K, V>;
    const lc = nodeCount(inner.left);
    if (idx < lc) {
      cur = inner.left as Node<K, V>;
    } else if (idx === lc) {
      return [inner.key, inner.value];
    } else {
      idx = idx - lc - 1;
      cur = inner.right as Node<K, V>;
    }
  }
}

/// Pre-condition: every key in `l` is less than every key in `r`.
function nodeJoinBalanced<K, V>(
  l: Node<K, V> | null,
  k: K,
  v: V,
  r: Node<K, V> | null,
): Node<K, V> {
  return unsafeBinary(l, k, v, r);
}

function nodeUnion<K, V>(
  cmp: KeyComparer<K>,
  resolve: (k: K, l: V, r: V) => V,
  a: Node<K, V> | null,
  b: Node<K, V> | null,
): Node<K, V> | null {
  if (a === null) return b;
  if (b === null) return a;
  // Insert each entry of `b` into `a` (right-wins by default).
  let result = a;
  nodeIter<K, V>((k, v) => {
    const existing = nodeTryFind(cmp, k, result);
    if (existing === undefined && !nodeContainsKey(cmp, k, result)) {
      result = nodeAdd(cmp, k, v, result);
    } else {
      result = nodeAdd(cmp, k, resolve(k, existing as V, v), result);
    }
  }, b);
  return result;
}

function nodeToList<K, V>(
  acc: Array<[K, V]>,
  node: Node<K, V> | null,
): Array<[K, V]> {
  nodeIter<K, V>((k, v) => acc.push([k, v]), node);
  return acc;
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

  alter(
    key: K,
    update: (existing: V | undefined) => V | undefined,
  ): MapExt<K, V> {
    const existing = nodeTryFind(this._cmp, key, this._root);
    const had = nodeContainsKey(this._cmp, key, this._root);
    const next = update(had ? existing : undefined);
    if (next === undefined) {
      return had ? this.remove(key) : this;
    }
    if (had && Object.is(existing, next)) return this;
    return this.add(key, next);
  }
  change = this.alter;
  changeV = this.alter;

  iter(action: (k: K, v: V) => void): void {
    nodeIter(action, this._root);
  }
  fold<S>(folder: (s: S, k: K, v: V) => S, state: S): S {
    return nodeFold(folder, state, this._root);
  }
  exists(predicate: (k: K, v: V) => boolean): boolean {
    return nodeExists(predicate, this._root);
  }
  forall(predicate: (k: K, v: V) => boolean): boolean {
    return nodeForall(predicate, this._root);
  }

  map<U>(mapping: (k: K, v: V) => U): MapExt<K, U> {
    return new MapExt<K, U>(nodeMap(mapping, this._root), this._cmp);
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
    return new MapExt<K, V>(
      nodeSlice(this._cmp, minKey, maxKey, this._root),
      this._cmp,
    );
  }

  neighbours(key: K): Neighbours<K, V> {
    return nodeNeighbours(this._cmp, key, this._root);
  }

  changeWithNeighbours(
    key: K,
    update: (
      left: [K, V] | undefined,
      self: V | undefined,
      right: [K, V] | undefined,
    ) => V | undefined,
  ): MapExt<K, V> {
    const n = this.neighbours(key);
    const next = update(n.left, n.self, n.right);
    if (next === undefined) {
      return n.self === undefined ? this : this.remove(key);
    }
    if (n.self !== undefined && Object.is(n.self, next)) return this;
    return this.add(key, next);
  }

  itemV(i: number): [K, V] | undefined {
    return nodeItemV(i, this._root);
  }

  tryGetIndex(key: K): number {
    return nodeTryGetIndex(this._cmp, key, this._root);
  }

  union(other: MapExt<K, V>): MapExt<K, V> {
    return this.unionWith(other, (_k, _l, r) => r);
  }

  unionWith(
    other: MapExt<K, V>,
    resolve: (k: K, l: V, r: V) => V,
  ): MapExt<K, V> {
    return new MapExt<K, V>(
      nodeUnion(this._cmp, resolve, this._root, other._root),
      this._cmp,
    );
  }

  toList(): Array<[K, V]> {
    return nodeToList<K, V>([], this._root);
  }
  toArray(): Array<[K, V]> {
    return this.toList();
  }
  toKeyList(): K[] {
    return this.toList().map((kv) => kv[0]);
  }
  toValueList(): V[] {
    return this.toList().map((kv) => kv[1]);
  }
  toSeq(): Iterable<[K, V]> {
    return this;
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    // In-order traversal via an explicit stack to avoid recursion.
    const stack: Array<Node<K, V>> = [];
    let cur: Node<K, V> | null = this._root;
    while (cur !== null || stack.length > 0) {
      while (cur !== null) {
        stack.push(cur);
        cur = cur.height === 1 ? null : (cur as Inner<K, V>).left;
      }
      const node = stack.pop()!;
      yield [node.key, node.value];
      cur = node.height === 1 ? null : (node as Inner<K, V>).right;
    }
  }

  /// Apply a delta against this map, emitting the new state and
  /// effective deltas (entries whose net effect changed the map).
  applyDeltaAndGetEffective<D, DOut>(
    delta: MapExt<K, D>,
    apply: (
      k: K,
      existing: V | undefined,
      d: D,
    ) => [V | undefined, DOut | undefined],
  ): { state: MapExt<K, V>; effective: MapExt<K, DOut> } {
    let state = this as MapExt<K, V>;
    let eff = MapExt.empty<K, DOut>(this._cmp as unknown as KeyComparer<K>);
    delta.iter((k, d) => {
      const existing = state.tryFind(k);
      const had = state.containsKey(k);
      const [newValue, emitted] = apply(k, had ? existing : undefined, d);
      if (newValue === undefined) {
        if (had) state = state.remove(k);
      } else {
        state = state.add(k, newValue);
      }
      if (emitted !== undefined) eff = eff.add(k, emitted);
    });
    return { state, effective: eff };
  }

  /// Compute a delta-as-MapExt mapping from this to `other` using
  /// per-key add/remove/update callbacks. Linear merge over both
  /// (sorted) iterators.
  computeDeltaTo<D>(
    other: MapExt<K, V>,
    add: (k: K, v: V) => D,
    update: (k: K, oldV: V, newV: V) => D | undefined,
    remove: (k: K, v: V) => D,
  ): MapExt<K, D> {
    const out: Array<[K, D]> = [];
    const a = this[Symbol.iterator]();
    const b = other[Symbol.iterator]();
    let na = a.next();
    let nb = b.next();
    while (!na.done && !nb.done) {
      const c = this._cmp(na.value[0], nb.value[0]);
      if (c < 0) {
        out.push([na.value[0], remove(na.value[0], na.value[1])]);
        na = a.next();
      } else if (c > 0) {
        out.push([nb.value[0], add(nb.value[0], nb.value[1])]);
        nb = b.next();
      } else {
        const u = update(na.value[0], na.value[1], nb.value[1]);
        if (u !== undefined) out.push([na.value[0], u]);
        na = a.next();
        nb = b.next();
      }
    }
    while (!na.done) {
      out.push([na.value[0], remove(na.value[0], na.value[1])]);
      na = a.next();
    }
    while (!nb.done) {
      out.push([nb.value[0], add(nb.value[0], nb.value[1])]);
      nb = b.next();
    }
    return MapExt.ofArray(out, this._cmp as unknown as KeyComparer<K>);
  }

  // ----- static factories -----

  static empty<K, V>(cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>(null, cmp);
  }
  static single<K, V>(key: K, value: V, cmp: KeyComparer<K>): MapExt<K, V> {
    return new MapExt<K, V>(new Node<K, V>(key, value, 1), cmp);
  }
  static ofSeq<K, V>(
    elements: Iterable<[K, V]>,
    cmp: KeyComparer<K>,
  ): MapExt<K, V> {
    let m = MapExt.empty<K, V>(cmp);
    for (const [k, v] of elements) m = m.add(k, v);
    return m;
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
