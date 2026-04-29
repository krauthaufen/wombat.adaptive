// Port of FSharp.Data.Adaptive.Reference/AdaptiveValue.fs
//
// PORT NOTE: this is the slow-but-obviously-correct reference
// implementation used to validate the real adaptive system. Every
// call recomputes from scratch — no caching, no transactions, no
// dependency tracking. The whole module is pull-on-demand.

/** Reference implementation for AdaptiveToken. */
export class AdaptiveToken {
  private constructor() {}
  static readonly top = new AdaptiveToken();
}

/** Reference implementations for aval. */
export interface aval<T> {
  getValue(t: AdaptiveToken): T;
}

/** Reference implementation for cval. */
export class ChangeableValue<T> implements aval<T> {
  private _value: T;
  constructor(value: T) {
    this._value = value;
  }
  /** Gets the current value of the cval. */
  getValue(_t: AdaptiveToken): T {
    return this._value;
  }
  get value(): T {
    return this._value;
  }
  set value(v: T) {
    this._value = v;
  }
}

export type cval<T> = ChangeableValue<T>;

/** Functional operators for the aval reference-implementation. */
export const AVal = {
  /** Gets the current value for the given adaptive value. */
  force<T>(value: aval<T>): T {
    return value.getValue(AdaptiveToken.top);
  },
  /** Creates a new cval initially holding the given value. */
  init<T>(value: T): ChangeableValue<T> {
    return new ChangeableValue<T>(value);
  },
  /** Creates an aval always holding the given value. */
  constant<T>(value: T): aval<T> {
    return { getValue: () => value };
  },
  /** Adaptively maps over the given aval and returns the resulting aval. */
  map<A, B>(mapping: (a: A) => B, input: aval<A>): aval<B> {
    return { getValue: (t) => mapping(input.getValue(t)) };
  },
  /** Adaptively maps over the given avals and returns the resulting aval. */
  map2<A, B, C>(
    mapping: (a: A, b: B) => C,
    v1: aval<A>,
    v2: aval<B>,
  ): aval<C> {
    return { getValue: (t) => mapping(v1.getValue(t), v2.getValue(t)) };
  },
  /** Adaptively maps over the given avals and returns the resulting aval. */
  map3<A, B, C, D>(
    mapping: (a: A, b: B, c: C) => D,
    v1: aval<A>,
    v2: aval<B>,
    v3: aval<C>,
  ): aval<D> {
    return {
      getValue: (t) => mapping(v1.getValue(t), v2.getValue(t), v3.getValue(t)),
    };
  },
  /**
   * Adaptively applies mapping to the given aval and also depends on the
   * inner aval.
   */
  bind<A, B>(mapping: (a: A) => aval<B>, input: aval<A>): aval<B> {
    return {
      getValue: (t) => mapping(input.getValue(t)).getValue(t),
    };
  },
  /**
   * Adaptively applies mapping to the given avals and also depends on the
   * inner aval.
   */
  bind2<A, B, C>(
    mapping: (a: A, b: B) => aval<C>,
    r1: aval<A>,
    r2: aval<B>,
  ): aval<C> {
    return {
      getValue: () => AVal.force(mapping(AVal.force(r1), AVal.force(r2))),
    };
  },
};

/** Reference implementation of `Seq.existsA` / `Seq.forallA`. */
export const Seq = {
  existsA<T>(predicate: (t: T) => aval<boolean>, elements: Iterable<T>): aval<boolean> {
    return {
      getValue: () => {
        for (const e of elements) if (AVal.force(predicate(e))) return true;
        return false;
      },
    };
  },
  forallA<T>(predicate: (t: T) => aval<boolean>, elements: Iterable<T>): aval<boolean> {
    return {
      getValue: () => {
        for (const e of elements) if (!AVal.force(predicate(e))) return false;
        return true;
      },
    };
  },
};
