// Port of FSharp.Data.Adaptive Core/Core.fs (the IAdaptiveObject and
// IWeakOutputSet interfaces only). The concrete WeakOutputSet
// implementation lives in ./weakOutputSet.ts.

/**
 * A mutable container for a value of type T. Used to model F#'s
 * `byref<T>` / `ref<T>` parameters where the callee may resize/replace
 * the underlying storage. Specifically used by IWeakOutputSet.consume
 * (the F# original is `ref<IAdaptiveObject[]>`).
 */
export interface OutputBuffer {
  value: (IAdaptiveObject | undefined)[];
}

/**
 * Represents the core interface for all adaptive objects.
 * Contains support for tracking OutOfDate flags, managing in-/outputs
 * and lazy/eager evaluation in the dependency tree.
 */
export interface IAdaptiveObject {
  /** User-provided tag. The library does not interpret this. */
  tag: unknown;

  /**
   * Each object can cache a WeakRef pointing to itself. Used internally
   * to hand out weak references to this object without re-allocating.
   */
  readonly weak: WeakRef<IAdaptiveObject>;

  /**
   * Used internally to represent the maximal distance from an input
   * cell in the dependency graph when evaluating inside a transaction.
   */
  level: number;

  /**
   * Allows a specific implementation to evaluate the cell during the
   * change propagation process.
   */
  mark(): boolean;

  /**
   * Indicates whether the object has been marked. In the F# original
   * this is documented as "should only be accessed when holding a lock
   * on the adaptive object". JS is single-threaded so the lock is gone,
   * but the rest of the protocol still relies on this flag flipping in
   * a specific order.
   */
  outOfDate: boolean;

  /**
   * The adaptive outputs for the object. Represented by weak references
   * to allow for unused parts of the graph to be garbage collected.
   */
  readonly outputs: IWeakOutputSet;

  /**
   * Gets called whenever a current input of the object gets marked
   * out of date. The first argument represents the Transaction that
   * causes the object to be marked.
   */
  inputChanged(transaction: unknown, object: IAdaptiveObject): void;

  /**
   * Gets called after all inputs of the object have been processed
   * and directly before the object will be marked.
   */
  allInputsProcessed(transaction: unknown): void;

  /** Indicates whether the IAdaptiveObject is constant. */
  readonly isConstant: boolean;
}

/**
 * Represents a set of outputs for an AdaptiveObject. The references to
 * all contained elements are weak and the datastructure allows to
 * add/remove entries. The only other functionality is consume which
 * returns all the (currently live) entries and clears the set.
 */
export interface IWeakOutputSet {
  /** Indicates whether the set is (conservatively) known to be empty. */
  readonly isEmpty: boolean;

  /**
   * Adds a weak reference to the given AdaptiveObject to the set.
   * Returns whether the obj was new.
   */
  add(o: IAdaptiveObject): boolean;

  /**
   * Removes the reference to the given AdaptiveObject from the set.
   * Returns whether the obj was removed.
   */
  remove(o: IAdaptiveObject): boolean;

  /**
   * Returns all currently living entries from the set and clears its
   * content. The output buffer is grown as needed. Returns the count
   * of entries written.
   */
  consume(output: OutputBuffer): number;

  /** Clears the set. */
  clear(): void;
}

/**
 * Helper used by IWeakOutputSet.consume implementations to grow the
 * output buffer when needed. Not exposed to callers directly.
 */
export function resizeOutputBuffer(buf: OutputBuffer, newSize: number): void {
  const old = buf.value;
  const next: (IAdaptiveObject | undefined)[] = new Array(newSize);
  for (let i = 0; i < old.length; i++) next[i] = old[i];
  buf.value = next;
}
