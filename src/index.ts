// Public API barrel for `@aardworx/adaptive`.
//
// Most consumers will import from this top-level module:
//
//   import { AVal, cval, ASet, cset, transact } from "@aardworx/adaptive";
//
// For finer-grained imports the sub-paths exposed via package.json
// `exports` are also available:
//
//   import { AVal, cval } from "@aardworx/adaptive/aval";
//   import { ASet, cset } from "@aardworx/adaptive/aset";
//   import { AMap, cmap } from "@aardworx/adaptive/amap";
//   import { AList, clist } from "@aardworx/adaptive/alist";
//   import { HashSet, HashMap, IndexList } from "@aardworx/adaptive/datastructures";
//   import { ASetBridges, AMapBridges } from "@aardworx/adaptive/extensions";

// Core
export {
  transact,
  transactIfNecessary,
  markOutdated,
  hasRunningTransaction,
} from "./core/transaction.js";
export { AdaptiveToken } from "./core/adaptiveToken.js";
export { AdaptiveObject } from "./core/adaptiveObject.js";
export type {
  IAdaptiveObject,
  IWeakOutputSet,
} from "./core/types.js";
export type { IDisposable } from "./core/callbacks.js";

// AVal
export {
  AVal,
  cval,
  ChangeableValue,
  AbstractVal,
  Zipped,
  init as cvalInit,
  constant as avalConstant,
  delay as avalDelay,
  custom as avalCustom,
  map as avalMap,
  bind as avalBind,
  mapNonAdaptive as avalMapNonAdaptive,
  zip as avalZip,
  force as avalForce,
  addCallback as avalAddCallback,
  addWeakCallback as avalAddWeakCallback,
} from "./adaptiveValue/adaptiveValue.js";
export type { aval } from "./adaptiveValue/adaptiveValue.js";

// AdaptiveReduction
export type { AdaptiveReduction } from "./adaptiveValue/adaptiveReduction.js";
export * as Reductions from "./adaptiveValue/adaptiveReduction.js";

// ASet
export {
  ASet,
  force as asetForce,
} from "./adaptiveHashSet/adaptiveHashSet.js";
export type {
  aset,
  IHashSetReader,
} from "./adaptiveHashSet/adaptiveHashSet.js";
export {
  ChangeableHashSet,
  ChangeableHashSetOps,
  cset,
} from "./adaptiveHashSet/changeableHashSet.js";

// AMap
export {
  AMap,
  KeyValuePair,
  force as amapForce,
} from "./adaptiveHashMap/adaptiveHashMap.js";
export type {
  amap,
  IHashMapReader,
} from "./adaptiveHashMap/adaptiveHashMap.js";
export {
  ChangeableHashMap,
  ChangeableHashMapOps,
  cmap,
} from "./adaptiveHashMap/changeableHashMap.js";

// AList
export {
  AList,
  force as alistForce,
} from "./adaptiveIndexList/adaptiveIndexList.js";
export type {
  alist,
  IIndexListReader,
} from "./adaptiveIndexList/adaptiveIndexList.js";
export {
  ChangeableIndexList,
  ChangeableIndexListOps,
  clist,
} from "./adaptiveIndexList/changeableIndexList.js";

// Datastructures (commonly needed alongside the adaptive types)
export {
  HashSet,
  HashMap,
  HashSetOps,
  HashMapOps,
} from "./datastructures/hashCollections.js";
export { IndexList, IndexListOps } from "./datastructures/indexList.js";
export {
  Index,
  indexZero,
  IndexOps,
} from "./datastructures/index.js";
export { MapExt } from "./datastructures/mapExt.js";
export {
  HashSetDelta,
  HashSetDeltaOps,
} from "./datastructures/hashSetDelta.js";
export {
  HashMapDelta,
  HashMapDeltaOps,
} from "./datastructures/hashMapDelta.js";
export {
  IndexListDelta,
  IndexListDeltaOps,
  IndexListDeltaExt,
} from "./datastructures/indexListDelta.js";
export {
  HashSetDeltaExt,
  HashMapDeltaExt,
} from "./datastructures/deltas.js";
export {
  SetOperation,
  ElementSet,
  ElementRemove,
} from "./datastructures/operations.js";
export type { ElementOperation } from "./datastructures/operations.js";
export {
  defaultEquals,
  defaultHash,
  defaultComparer,
  comparerFor,
} from "./datastructures/equality.js";
export type { IEqualityComparer } from "./datastructures/equality.js";

// Traceable / History (advanced — reader/extension authors)
export {
  History,
  AbstractReader,
  AbstractStatefulReader,
  AbstractDirtyReader,
  EmptyReader,
  ConstantReader,
} from "./traceable/history.js";
export type {
  IOpReader,
  IOpReaderWithState,
} from "./traceable/history.js";
export type { Monoid, Traceable } from "./traceable/traceable.js";
export {
  CountingHashSet,
  CountingHashSetOps,
  hashSetTrace,
  hashSetDeltaMonoid,
} from "./traceable/countingHashSet.js";
export {
  hashMapTrace,
  hashMapDeltaMonoid,
} from "./traceable/hashMapTraceable.js";
export {
  indexListTrace,
  indexListDeltaMonoid,
} from "./traceable/indexListTraceable.js";

// Utilities (extension authors)
export { Cache } from "./utilities/cache.js";
export { HashTable } from "./utilities/hashTable.js";
export { IndexCache } from "./utilities/indexCache.js";
export { IndexMapping } from "./utilities/indexMapping.js";
export type { Compare } from "./utilities/indexMapping.js";
export { Unique } from "./utilities/unique.js";
export { rangeChange } from "./utilities/rangeDelta.js";
export type { RangeChangeRegions } from "./utilities/rangeDelta.js";

// Collection extensions
export {
  AValExt,
  ListExt,
  SeqExt,
  HashSetExt,
  HashMapExt,
  AMapExt,
} from "./collectionExtensions/collectionExtensions.js";
export {
  ASetBridges,
  AMapBridges,
  AListBridges,
} from "./collectionExtensions/bridges.js";
export {
  asetCallback,
  asetWeakCallback,
  amapCallback,
  amapWeakCallback,
  alistCallback,
  alistWeakCallback,
  readerCallback,
  readerWeakCallback,
} from "./collectionExtensions/callbacks.js";

// MultiSetMap (low-level — used by reduceByA-style readers)
export { MultiSetMap } from "./datastructures/multiSetMap.js";
