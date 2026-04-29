// Port of FSharp.Data.Adaptive/CollectionExtensions.fs
//
// Subset: AdaptiveOr / AdaptiveAnd over a list of aval<boolean>, plus
// `Seq.existsA`/`Seq.forallA`/`HashSet.existsA`/`HashSet.forallA`/
// `HashMap.existsA`/`HashMap.forallA`/`AVal.logicalAnd`/`AVal.logicalOr`,
// and `AMap.keys`.

import {
  AbstractVal,
  AVal,
  type aval,
} from "../adaptiveValue/adaptiveValue.js";
import { AdaptiveToken } from "../core/adaptiveToken.js";
import type { IAdaptiveObject } from "../core/types.js";
import {
  HashSet,
  HashMap,
} from "../datastructures/hashCollections.js";
import { HashSetDelta } from "../datastructures/hashSetDelta.js";
import { AbstractReader } from "../traceable/history.js";
import {
  ASet as ASetOps,
  type aset,
} from "../adaptiveHashSet/adaptiveHashSet.js";
import type { amap, IHashMapReader } from "../adaptiveHashMap/adaptiveHashMap.js";

// ---------------------------------------------------------------------------
// Boolean reductions over lists of avals (witness-tracking, like F#).
// ---------------------------------------------------------------------------

class AdaptiveOr extends AbstractVal<boolean> {
  private readonly _values: ReadonlyArray<aval<boolean>>;
  private _witness: aval<boolean> | null = null;
  constructor(values: ReadonlyArray<aval<boolean>>) {
    super();
    this._values = values;
  }
  /** Returns the first aval whose value is `true` (and the rest). */
  private findWitness(
    token: AdaptiveToken,
  ): { witness: aval<boolean> | null; rest: aval<boolean>[] } {
    const rest: aval<boolean>[] = [];
    let witness: aval<boolean> | null = null;
    for (const a of this._values) {
      if (witness === null && a.getValue(token)) witness = a;
      else rest.push(a);
    }
    return { witness, rest };
  }
  override compute(token: AdaptiveToken): boolean {
    if (this._witness !== null) {
      if (this._witness.getValue(token)) return true;
      const { witness, rest } = this.findWitness(token);
      this._witness = witness;
      if (witness !== null) {
        for (const r of rest)
          (r as unknown as IAdaptiveObject).outputs.remove(this);
        return true;
      }
      return false;
    }
    const { witness, rest } = this.findWitness(token);
    this._witness = witness;
    if (witness !== null) {
      for (const r of rest)
        (r as unknown as IAdaptiveObject).outputs.remove(this);
      return true;
    }
    return false;
  }
}

class AdaptiveAnd extends AbstractVal<boolean> {
  private readonly _values: ReadonlyArray<aval<boolean>>;
  private _witness: aval<boolean> | null = null;
  constructor(values: ReadonlyArray<aval<boolean>>) {
    super();
    this._values = values;
  }
  /** Returns the first aval whose value is `false` (the failing witness). */
  private findWitness(
    token: AdaptiveToken,
  ): { witness: aval<boolean> | null; rest: aval<boolean>[] } {
    const rest: aval<boolean>[] = [];
    let witness: aval<boolean> | null = null;
    for (const a of this._values) {
      if (witness === null && !a.getValue(token)) witness = a;
      else rest.push(a);
    }
    return { witness, rest };
  }
  override compute(token: AdaptiveToken): boolean {
    if (this._witness !== null) {
      if (this._witness.getValue(token)) {
        // Previous false-witness is now true; look for a new one.
        const { witness, rest } = this.findWitness(token);
        this._witness = witness;
        if (witness !== null) {
          for (const r of rest)
            (r as unknown as IAdaptiveObject).outputs.remove(this);
          return false;
        }
        return true;
      }
      return false;
    }
    const { witness, rest } = this.findWitness(token);
    this._witness = witness;
    if (witness !== null) {
      for (const r of rest)
        (r as unknown as IAdaptiveObject).outputs.remove(this);
      return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// AVal.logicalAnd / logicalOr / List.existsA / List.forallA
// ---------------------------------------------------------------------------

export const AValExt = {
  logicalAnd(values: Iterable<aval<boolean>>): aval<boolean> {
    return new AdaptiveAnd([...values]);
  },
  logicalOr(values: Iterable<aval<boolean>>): aval<boolean> {
    return new AdaptiveOr([...values]);
  },
};

function partitionConstants(
  avals: aval<boolean>[],
): { constant: aval<boolean>[]; adaptive: aval<boolean>[] } {
  const constant: aval<boolean>[] = [];
  const adaptive: aval<boolean>[] = [];
  for (const v of avals) (v.isConstant ? constant : adaptive).push(v);
  return { constant, adaptive };
}

export const ListExt = {
  existsA<T>(predicate: (t: T) => aval<boolean>, elements: T[]): aval<boolean> {
    const mapped = elements.map(predicate);
    const { constant, adaptive } = partitionConstants(mapped);
    if (constant.some((v) => AVal.force(v))) return AVal.constant(true);
    if (adaptive.length === 0) return AVal.constant(false);
    return new AdaptiveOr(adaptive);
  },
  forallA<T>(predicate: (t: T) => aval<boolean>, elements: T[]): aval<boolean> {
    const mapped = elements.map(predicate);
    const { constant, adaptive } = partitionConstants(mapped);
    if (constant.some((v) => !AVal.force(v))) return AVal.constant(false);
    if (adaptive.length === 0) return AVal.constant(true);
    return new AdaptiveAnd(adaptive);
  },
};

export const SeqExt = {
  existsA<T>(
    predicate: (t: T) => aval<boolean>,
    elements: Iterable<T>,
  ): aval<boolean> {
    return ListExt.existsA(predicate, [...elements]);
  },
  forallA<T>(
    predicate: (t: T) => aval<boolean>,
    elements: Iterable<T>,
  ): aval<boolean> {
    return ListExt.forallA(predicate, [...elements]);
  },
};

export const HashSetExt = {
  existsA<T>(
    predicate: (t: T) => aval<boolean>,
    elements: HashSet<T>,
  ): aval<boolean> {
    return ListExt.existsA(predicate, elements.toList());
  },
  forallA<T>(
    predicate: (t: T) => aval<boolean>,
    elements: HashSet<T>,
  ): aval<boolean> {
    return ListExt.forallA(predicate, elements.toList());
  },
};

export const HashMapExt = {
  existsA<K, V>(
    predicate: (k: K, v: V) => aval<boolean>,
    elements: HashMap<K, V>,
  ): aval<boolean> {
    return ListExt.existsA<[K, V]>(([k, v]) => predicate(k, v), [...elements]);
  },
  forallA<K, V>(
    predicate: (k: K, v: V) => aval<boolean>,
    elements: HashMap<K, V>,
  ): aval<boolean> {
    return ListExt.forallA<[K, V]>(([k, v]) => predicate(k, v), [...elements]);
  },
};

// ---------------------------------------------------------------------------
// AMap.keys
// ---------------------------------------------------------------------------

class MapKeysReader<K, V> extends AbstractReader<HashSetDelta<K>> {
  private readonly _reader: IHashMapReader<K, V>;
  constructor(input: amap<K, V>) {
    super(HashSetDelta.empty<K>());
    this._reader = input.getReader();
  }
  override compute(token: AdaptiveToken): HashSetDelta<K> {
    const old = this._reader.state;
    const ops = this._reader.getChanges(token);
    let out = HashMap.empty<K, number>();
    for (const [key, op] of ops) {
      if (op.tag === "Set") {
        if (!old.containsKey(key)) out = out.add(key, 1);
      } else {
        if (old.containsKey(key)) out = out.add(key, -1);
      }
    }
    return HashSetDelta.ofHashMap(out);
  }
}

export const AMapExt = {
  /** Adaptive set of all keys in the map. */
  keys<K, V>(map: amap<K, V>): aset<K> {
    if (map.isConstant) {
      return ASetOps.constant<K>(() =>
        HashSet.ofSeq([...AVal.force(map.content)].map(([k]) => k)),
      );
    }
    return ASetOps.ofReader<K>(() => new MapKeysReader<K, V>(map));
  },
};
