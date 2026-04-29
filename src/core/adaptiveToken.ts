// Port of FSharp.Data.Adaptive Core/AdaptiveToken.fs

import type { IAdaptiveObject } from "./types.js";

/**
 * AdaptiveToken represents a token that can be passed to
 * inner AdaptiveObjects for evaluation.
 * When passing an AdaptiveToken to the evaluation-function of
 * a cell the system will create a dependency edge internally and
 * future marking of the inner cell will also cause the calling cell to
 * be marked.
 */
//
// PORT NOTE: F# original was a `[<Struct>]` with a single mutable field
// `caller`. We use a class with a single field; allocations are cheap
// in JS and matching the F# struct semantics requires no special handling.
// `null` represents "no caller" (the F# code uses `Unchecked.isNull`).
//
// PORT NOTE: F# also exposes `WithCancellationToken` and a `Cancelable`
// constructor for parity with .NET CancellationToken. Neither is used by
// the core library — the cancellation token is stored but never observed.
// Not ported.
export class AdaptiveToken {
  /** Represents the calling IAdaptiveObject or null if none. */
  caller: IAdaptiveObject | null;

  constructor(caller: IAdaptiveObject | null) {
    this.caller = caller;
  }

  /** Creates a new AdaptiveToken with the given caller. */
  withCaller(c: IAdaptiveObject): AdaptiveToken {
    return new AdaptiveToken(c);
  }

  /** The top-level AdaptiveToken without a calling IAdaptiveObject. */
  static readonly top: AdaptiveToken = new AdaptiveToken(null);
}
