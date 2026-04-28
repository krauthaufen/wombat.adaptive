// Port of FSharp.Data.Adaptive Utilities/PriorityQueue.fs and the
// HeapExtensions block of Utilities.fs. The commented-out experimental
// HashQueue2/3/4 types in the F# original are not ported.

// ---------------------------------------------------------------------------
// HeapExtensions: in-place binary min-heap operations on a plain array
// (F# original: extension methods on List<'T> in Utilities.fs)
// ---------------------------------------------------------------------------

/// Swaps the given elements inside the array.
function swap<T>(heap: T[], l: number, r: number): void {
  const t = heap[l]!;
  heap[l] = heap[r]!;
  heap[r] = t;
}

/// Moves an element in the array 'up' in heap-order.
/// Assumes that the array is in heap-order except for the given element.
function bubbleUp<T>(
  heap: T[],
  compare: (a: T, b: T) => number,
  i: number,
  v: T,
): void {
  while (i > 0) {
    const pi = (i - 1) >>> 1;
    const pe = heap[pi]!;
    if (compare(pe, v) > 0) {
      swap(heap, pi, i);
      i = pi;
    } else {
      return;
    }
  }
}

/// Moves an element in the array 'down' in heap-order.
/// Assumes that the array is in heap-order except for the given element.
function pushDown<T>(
  heap: T[],
  compare: (a: T, b: T) => number,
  i: number,
  v: T,
): void {
  // The F# original is recursive; iterative form is structurally equivalent.
  for (;;) {
    const li = (i << 1) + 1;
    const ri = li + 1;
    const cl = li < heap.length ? compare(v, heap[li]!) <= 0 : true;
    const cr = ri < heap.length ? compare(v, heap[ri]!) <= 0 : true;

    if (cl && !cr) {
      swap(heap, ri, i);
      i = ri;
    } else if (!cl && cr) {
      swap(heap, li, i);
      i = li;
    } else if (!cl && !cr) {
      const c = compare(heap[li]!, heap[ri]!);
      if (c < 0) {
        swap(heap, li, i);
        i = li;
      } else {
        swap(heap, ri, i);
        i = ri;
      }
    } else {
      return;
    }
  }
}

/// Enqueues an element to the array in heap-order.
export function heapEnqueue<T>(
  heap: T[],
  compare: (a: T, b: T) => number,
  value: T,
): void {
  const index = heap.length;
  heap.push(value);
  bubbleUp(heap, compare, index, value);
}

/// Dequeues the smallest element from the heap-order array.
export function heapDequeue<T>(
  heap: T[],
  compare: (a: T, b: T) => number,
): T {
  if (heap.length === 0) throw new Error("heap empty");
  const result = heap[0]!;
  const li = heap.length - 1;
  const l = heap[li]!;
  heap.pop();
  if (li > 0) {
    heap[0] = l;
    pushDown(heap, compare, 0, l);
  }
  return result;
}

// ---------------------------------------------------------------------------
// TransactQueue<V>
// ---------------------------------------------------------------------------
//
// PORT NOTE: the F# original used a hand-rolled hash table with prime-sized
// buckets and linked entries (TransactQueueEntry's Hash/Slot/Prev/Next fields)
// to provide reference-equality dedup with .NET's RuntimeHelpers.GetHashCode.
// JavaScript's Map already uses identity for object keys (sameValueZero), so
// we use Map<V, Entry> for the dedup index. The binary-heap part of the
// implementation is preserved structurally.
//
// Behavioural contract (matches the F# version):
//   - int-keyed priority queue
//   - each value (by reference) can only be enqueued once; subsequent
//     Enqueue calls with the same value are no-ops
//   - Dequeue returns the entry with the smallest key
//   - order among entries with the same key is undefined

interface Entry<V> {
  key: number;
  value: V;
}

/// Implements a priority queue (with int as priority) where each
/// value (by reference) can only be enqueued once.
/// Note that the order for 'colliding' keys is undefined.
export class TransactQueue<V extends object> {
  private readonly _heap: Entry<V>[] = [];
  private readonly _index: Map<V, Entry<V>> = new Map();

  private static readonly _cmp = (a: Entry<unknown>, b: Entry<unknown>) =>
    a.key - b.key;

  /// Is the queue empty?
  get isEmpty(): boolean {
    return this._index.size === 0;
  }

  /// Does the queue contain the given value?
  contains(value: V): boolean {
    return this._index.has(value);
  }

  /// Enqueue a key/value pair to the queue.
  enqueue(key: number, value: V): void {
    if (this._index.has(value)) return;
    const entry: Entry<V> = { key, value };
    this._index.set(value, entry);
    heapEnqueue(this._heap, TransactQueue._cmp, entry);
  }

  /// Dequeues the minimal element from the queue and returns the
  /// key/value pair.
  dequeue(): { key: number; value: V } {
    const entry = heapDequeue(this._heap, TransactQueue._cmp);
    this._index.delete(entry.value);
    return { key: entry.key, value: entry.value };
  }
}
