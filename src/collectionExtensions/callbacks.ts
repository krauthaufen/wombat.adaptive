// Port of FSharp.Data.Adaptive EvaluationCallbackExtensions.fs for
// the collection types (aset / amap / alist) and `IOpReader`.
//
// Each callback fires once on subscription with the current state
// and the full empty-to-current delta, then on every transaction
// finalizer when the underlying reader has new changes. `weak`
// holds the reader/marking-callback weakly.

import { AdaptiveToken } from "../core/adaptiveToken.js";
import {
  getRunningTransaction,
} from "../core/transaction.js";
import type { AdaptiveObject } from "../core/adaptiveObject.js";
import type { IDisposable } from "../core/callbacks.js";
import {
  type IOpReaderWithState,
} from "../traceable/history.js";

import type { aset } from "../adaptiveHashSet/adaptiveHashSet.js";
import type { CountingHashSet } from "../traceable/countingHashSet.js";
import type { HashSetDelta } from "../datastructures/hashSetDelta.js";

import type { amap } from "../adaptiveHashMap/adaptiveHashMap.js";
import type { HashMap } from "../datastructures/hashCollections.js";
import type { HashMapDelta } from "../datastructures/hashMapDelta.js";

import type { alist } from "../adaptiveIndexList/adaptiveIndexList.js";
import type { IndexList } from "../datastructures/indexList.js";
import type { IndexListDelta } from "../datastructures/indexListDelta.js";

/**
 * Internal helper: subscribe to a reader, firing `action(state, delta)`
 * once on subscription with the current state and the empty-to-current
 * delta, then on every transaction finalizer when new changes exist.
 */
function readerAddCallback<State, Delta>(
  reader: IOpReaderWithState<State, Delta>,
  weak: boolean,
  action: (state: State, delta: Delta) => void,
): IDisposable {
  const trace = reader.trace;
  const isEmpty = trace.tmonoid.misEmpty;

  const run = () => {
    const state = reader.state;
    const changes = reader.getChanges(AdaptiveToken.top);
    if (!isEmpty(changes)) action(state, changes);
  };

  const obj = reader as unknown as AdaptiveObject;
  const sub = weak
    ? obj.addWeakMarkingCallback(() => {
        const t = getRunningTransaction();
        if (t !== null) t.addFinalizer(run);
        else run();
      })
    : obj.addMarkingCallback(() => {
        const t = getRunningTransaction();
        if (t !== null) t.addFinalizer(run);
        else run();
      });

  // Initial fire (deferred when inside a transaction).
  const t0 = getRunningTransaction();
  if (t0 !== null) t0.addFinalizer(run);
  else run();

  return sub;
}

// ---------------------------------------------------------------------------
// IOpReader<State, Delta>
// ---------------------------------------------------------------------------

export function readerCallback<State, Delta>(
  reader: IOpReaderWithState<State, Delta>,
  action: (state: State, delta: Delta) => void,
): IDisposable {
  return readerAddCallback(reader, false, action);
}

export function readerWeakCallback<State, Delta>(
  reader: IOpReaderWithState<State, Delta>,
  action: (state: State, delta: Delta) => void,
): IDisposable {
  return readerAddCallback(reader, true, action);
}

// ---------------------------------------------------------------------------
// aset / amap / alist subscription
// ---------------------------------------------------------------------------

export function asetCallback<T>(
  set: aset<T>,
  action: (state: CountingHashSet<T>, delta: HashSetDelta<T>) => void,
): IDisposable {
  return readerAddCallback(set.getReader(), false, action);
}
export function asetWeakCallback<T>(
  set: aset<T>,
  action: (state: CountingHashSet<T>, delta: HashSetDelta<T>) => void,
): IDisposable {
  return readerAddCallback(set.getReader(), true, action);
}

export function amapCallback<K, V>(
  map: amap<K, V>,
  action: (state: HashMap<K, V>, delta: HashMapDelta<K, V>) => void,
): IDisposable {
  return readerAddCallback(map.getReader(), false, action);
}
export function amapWeakCallback<K, V>(
  map: amap<K, V>,
  action: (state: HashMap<K, V>, delta: HashMapDelta<K, V>) => void,
): IDisposable {
  return readerAddCallback(map.getReader(), true, action);
}

export function alistCallback<T>(
  list: alist<T>,
  action: (state: IndexList<T>, delta: IndexListDelta<T>) => void,
): IDisposable {
  return readerAddCallback(list.getReader(), false, action);
}
export function alistWeakCallback<T>(
  list: alist<T>,
  action: (state: IndexList<T>, delta: IndexListDelta<T>) => void,
): IDisposable {
  return readerAddCallback(list.getReader(), true, action);
}
