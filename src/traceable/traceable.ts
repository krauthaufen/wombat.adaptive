// Port of FSharp.Data.Adaptive Traceable/Traceable.fs

/** Function table for a monoid instance. */
export interface Monoid<T> {
  /** Determines whether the given value is empty. */
  readonly misEmpty: (v: T) => boolean;
  /** The empty element. */
  readonly mempty: T;
  /** Appends two values. */
  readonly mappend: (l: T, r: T) => T;
}

/** Function table for a traceable instance. */
export interface Traceable<State, Delta> {
  /** The monoid instance for `Delta`. */
  readonly tmonoid: Monoid<Delta>;
  /** The empty state. */
  readonly tempty: State;
  /**
   * Applies the given operations to the state and returns the new
   * state accompanied by the (possibly reduced) effective ops.
   */
  readonly tapplyDelta: (state: State, delta: Delta) => [State, Delta];
  /** Differentiates two states and returns the needed ops. */
  readonly tcomputeDelta: (a: State, b: State) => Delta;
  /** Determines the size of an operation. */
  readonly tsize: (delta: Delta) => number;
  /**
   * Optional history-pruning predicate. When supplied, the History
   * implementation may discard cached versions and reproduce them on
   * demand via `tcomputeDelta`. The first argument is the base-state
   * for the history, the second the size of the operation that would
   * need to be applied.
   */
  readonly tprune: ((baseState: State, opSize: number) => boolean) | undefined;
}
