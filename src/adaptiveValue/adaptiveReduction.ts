// Port of FSharp.Data.Adaptive AdaptiveValue/AdaptiveReduction.fs
//
// PORT NOTE: F# `[<Struct>]` record becomes a TS interface with explicit
// fields. F# `ValueOption<T>` (Some/None) maps to `T | undefined` here:
// `undefined` denotes the negative case (no inverse possible). The `sub`
// callback returns `T | undefined`.
//
// PORT NOTE: F# `LanguagePrimitives.GenericZero/GenericOne/DivideByInt`
// only make sense in F# generic-numeric contexts. The TS port keeps the
// `count` reduction working over numbers; sum/average/product accept the
// concrete `number` type rather than being generic over numerics. F#'s
// `inline sum/average/product` were inline so they could specialise per
// numeric type — TS has no equivalent.

/**
 * AdaptiveReduction encodes a fold-with-inverse: an accumulator type
 * `S`, a way to add an element of type `A`, an optional way to subtract,
 * and a `view` projection from `S` to the externally observable `V`.
 */
export interface AdaptiveReduction<A, S, V> {
  readonly seed: S;
  readonly add: (s: S, a: A) => S;
  readonly sub: (s: S, a: A) => S | undefined;
  readonly view: (s: S) => V;
}

export function par<A, SL, VL, SR, VR>(
  left: AdaptiveReduction<A, SL, VL>,
  right: AdaptiveReduction<A, SR, VR>,
): AdaptiveReduction<A, [SL, SR], [VL, VR]> {
  return {
    seed: [left.seed, right.seed],
    add: ([s, t], a) => [left.add(s, a), right.add(t, a)],
    sub: ([s, t], a) => {
      const sNew = left.sub(s, a);
      if (sNew === undefined) return undefined;
      const tNew = right.sub(t, a);
      if (tNew === undefined) return undefined;
      return [sNew, tNew];
    },
    view: ([s, t]) => [left.view(s), right.view(t)],
  };
}

// PORT NOTE: F# `structpar` is identical to `par` semantically; only the
// internal tuple representation differs (`struct(...)` vs reference tuple).
// JS has no struct distinction — only one variant ported.

export function mapIn<A, B, S, V>(
  mapping: (a: A) => B,
  reduction: AdaptiveReduction<B, S, V>,
): AdaptiveReduction<A, S, V> {
  return {
    seed: reduction.seed,
    add: (s, a) => reduction.add(s, mapping(a)),
    sub: (s, a) => reduction.sub(s, mapping(a)),
    view: reduction.view,
  };
}

export function mapOut<A, S, V, W>(
  mapping: (v: V) => W,
  reduction: AdaptiveReduction<A, S, V>,
): AdaptiveReduction<A, S, W> {
  return {
    seed: reduction.seed,
    add: reduction.add,
    sub: reduction.sub,
    view: (s) => mapping(reduction.view(s)),
  };
}

/** Counts elements (positive add, negative sub). */
export const count: AdaptiveReduction<unknown, number, number> = {
  seed: 0,
  add: (s, _a) => s + 1,
  sub: (s, _a) => s - 1,
  view: (s) => s,
};

export function group<A, S>(
  zero: S,
  add: (s: S, a: A) => S,
  sub: (s: S, a: A) => S,
): AdaptiveReduction<A, S, S> {
  return {
    seed: zero,
    add,
    sub: (s, a) => sub(s, a),
    view: (s) => s,
  };
}

export function halfGroup<A, S>(
  zero: S,
  add: (s: S, a: A) => S,
  sub: (s: S, a: A) => S | undefined,
): AdaptiveReduction<A, S, S> {
  return { seed: zero, add, sub, view: (s) => s };
}

export function fold<A, S>(
  zero: S,
  add: (s: S, a: A) => S,
): AdaptiveReduction<A, S, S> {
  return {
    seed: zero,
    add,
    sub: (_s, _a) => undefined,
    view: (s) => s,
  };
}

export const countPositive: AdaptiveReduction<boolean, number, number> = {
  seed: 0,
  add: (s, a) => s + (a ? 1 : 0),
  sub: (s, a) => s - (a ? 1 : 0),
  view: (s) => s,
};

export const countNegative: AdaptiveReduction<boolean, number, number> = {
  seed: 0,
  add: (s, a) => s + (a ? 0 : 1),
  sub: (s, a) => s - (a ? 0 : 1),
  view: (s) => s,
};

/** `tryMin` over a comparable type `A`. Comparison must be a total order. */
export function tryMin<A>(
  compare: (l: A, r: A) => number,
): AdaptiveReduction<A, A | undefined, A | undefined> {
  return {
    seed: undefined,
    add: (o, v) => (o === undefined ? v : compare(o, v) <= 0 ? o : v),
    sub: (o, v) => {
      if (o === undefined) return undefined; // F# returned ValueSome ValueNone
      return compare(v, o) > 0 ? o : undefined;
    },
    view: (s) => s,
  };
}

export function tryMax<A>(
  compare: (l: A, r: A) => number,
): AdaptiveReduction<A, A | undefined, A | undefined> {
  return {
    seed: undefined,
    add: (o, v) => (o === undefined ? v : compare(o, v) >= 0 ? o : v),
    sub: (o, v) => {
      if (o === undefined) return undefined;
      return compare(v, o) < 0 ? o : undefined;
    },
    view: (s) => s,
  };
}

/** Numeric sum over `number`. */
export const sum: AdaptiveReduction<number, number, number> = {
  seed: 0,
  add: (s, a) => s + a,
  sub: (s, a) => s - a,
  view: (s) => s,
};

/** Numeric average over `number`. */
export const average: AdaptiveReduction<number, [number, number], number> = {
  seed: [0, 0],
  add: ([c, s], a) => [c + 1, s + a],
  sub: ([c, s], a) => [c - 1, s - a],
  view: ([c, s]) => (c === 0 ? 0 : s / c),
};

/**
 * Numeric product over `number`. Subtraction returns `undefined`
 * when the divisor is zero (no inverse).
 */
export const product: AdaptiveReduction<number, number, number> = {
  seed: 1,
  add: (s, a) => s * a,
  sub: (s, a) => (a !== 0 ? s / a : undefined),
  view: (s) => s,
};
