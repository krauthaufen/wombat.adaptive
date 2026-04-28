// Port of FSharp.Data.Adaptive Datastructures/Index.fs
//
// PORT NOTE: F# stores tags as `uint64`. JS has no native uint64 — we
// use BigInt. Performance is somewhat worse but precision is preserved
// for the relabeling logic. (Switching to `number` would lose precision
// after a few hundred thousand inserts and was rejected.)
//
// PORT NOTE: F# uses a cyclic doubly-linked list of `IndexNode`s with
// concurrent locking via `Monitor.Enter`/`Monitor.Exit`. JS is
// single-threaded, so all locks are removed. The relabeling algorithm,
// the insertion-between-tags logic, and the reference-count-based
// disposal are preserved structurally.

const UINT64_MAX = (1n << 64n) - 1n;
const UINT64_MOD = 1n << 64n;
const HALF = 1n << 63n;

/// Wrap BigInt arithmetic into the unsigned 64-bit range.
function u64(x: bigint): bigint {
  // ((x % MOD) + MOD) % MOD — handles negatives.
  let r = x % UINT64_MOD;
  if (r < 0n) r += UINT64_MOD;
  return r;
}

/// Internal node in the order-maintenance cycle. Each node carries a
/// uint64 tag; the list is kept in tag order around a cycle. New nodes
/// are inserted between two existing nodes by averaging their tags;
/// when two adjacent tags differ by 1 we relabel a portion of the
/// chain to make room.
class IndexNode {
  /// Root-node for this cycle.
  root!: IndexNode;
  /// Prev node in the cycle.
  prev!: IndexNode;
  /// Next node in the cycle.
  next!: IndexNode;
  /// The current tag.
  tag: bigint = 0n;
  /// Reference count for tracking disposal.
  refCount = 1;

  /// Sort key relative to root.
  get key(): bigint {
    return u64(this.tag - this.root.tag);
  }

  /// Relabel a portion of the list starting at `start` until
  /// distance(start, current) >= cnt^2 + 1. Amortised O(log N) per
  /// insert.
  private static relabel(start: IndexNode): bigint {
    const all: IndexNode[] = [];

    const distance = (l: IndexNode, r: IndexNode): bigint => {
      if (l === r) return UINT64_MAX;
      return u64(r.tag - l.tag);
    };

    let current = start.next;
    all.push(start.next);

    let cnt = 1n;
    while (distance(start, current) < 1n + cnt * cnt) {
      current = current.next;
      cnt += 1n;
      all.push(current);
    }

    const space = distance(start, current);

    // The last node does not get relabeled.
    current = current.prev;
    all.pop();
    cnt -= 1n;

    const step = space / (1n + cnt);
    let nextTag = u64(start.tag + step);
    for (const n of all) {
      n.tag = nextTag;
      nextTag = u64(nextTag + step);
    }

    return step;
  }

  /// Insert a node directly after this one.
  insertAfter(): IndexNode {
    const next = this.next;

    let distance: bigint =
      next === this ? UINT64_MAX : u64(next.tag - this.tag);

    if (distance === 1n) {
      distance = IndexNode.relabel(this);
    }

    const key = u64(this.tag + distance / 2n);
    const res = new IndexNode(this.root);
    res.prev = this;
    res.next = next;
    res.tag = key;

    next.prev = res;
    this.next = res;

    return res;
  }

  /// Decrement refCount; remove from cycle when zero.
  delete(): void {
    if (this.refCount === 1) {
      this.prev.next = this.next;
      this.next.prev = this.prev;
      this.next = undefined as unknown as IndexNode;
      this.prev = undefined as unknown as IndexNode;
      this.refCount = 0;
    } else {
      this.refCount -= 1;
    }
  }

  compareTo(o: IndexNode): number {
    if (this === o) return 0;
    return this.key < o.key ? -1 : this.key > o.key ? 1 : 0;
  }

  equals(o: IndexNode): boolean {
    return this === o;
  }

  toString(): string {
    return Number(this.key) / Number(UINT64_MAX) + "";
  }

  constructor(root: IndexNode | null) {
    if (root === null) {
      // root constructor — points to self
      this.root = this;
      this.prev = this;
      this.next = this;
      this.tag = 0n;
    } else {
      this.root = root;
    }
    this.refCount = 1;
  }
}

/// Datastructure representing an abstract index.
/// Supported operations: `zero`, `after`, `before`, `between`.
/// O(log N) insert (amortised), O(1) delete, O(1) compare.
export class Index {
  /** @internal */
  readonly _real: IndexNode;

  private constructor(real: IndexNode) {
    this._real = real;
  }

  /// Returns an Index immediately after this one.
  after(): Index {
    const next = this._real.next;
    if (next !== this._real.root) {
      next.refCount += 1;
      return new Index(next);
    }
    return new Index(this._real.insertAfter());
  }

  /// Returns an Index immediately before this one.
  before(): Index {
    const prev = this._real.prev;
    if (prev === this._real.root) {
      return new Index(prev.insertAfter());
    }
    prev.refCount += 1;
    return new Index(prev);
  }

  /// Returns an Index strictly between this and `r`.
  between(r: Index): Index {
    const l = this._real;
    const right = r._real;
    if (right === l) {
      throw new Error("Index.between: indices are equal");
    }
    let nextOfL = l.next;
    if (nextOfL === right) {
      // No room — insert between by inserting after l (which may relabel).
      return new Index(l.insertAfter());
    }
    // Take a reference to l.next, which is a strictly between l and r in
    // tag order (since we walked one step).
    nextOfL.refCount += 1;
    return new Index(nextOfL);
  }

  compareTo(o: Index): number {
    return this._real.compareTo(o._real);
  }

  equals(o: Index): boolean {
    return this._real === o._real;
  }

  toString(): string {
    return this._real.toString();
  }

  /** @internal */
  static fromNode(n: IndexNode): Index {
    return new Index(n);
  }
}

// ---------------------------------------------------------------------------
// Module surface mirroring F# `module Index`.
// ---------------------------------------------------------------------------

const _rootNode = new IndexNode(null);
/// The root index.
export const indexZero: Index = Index.fromNode(_rootNode);

export const IndexOps = {
  zero: indexZero,
  after: (i: Index): Index => i.after(),
  before: (i: Index): Index => i.before(),
  between: (a: Index, b: Index): Index => a.between(b),
};
