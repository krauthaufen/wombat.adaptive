import { describe, expect, it } from "vitest";
import { clist } from "../src/adaptiveIndexList/changeableIndexList.js";
import { transact } from "../src/core/transaction.js";
import { AdaptiveToken } from "../src/core/adaptiveToken.js";

describe("clist.updateToArray", () => {
  const run = (from: number[], to: number[]) => {
    const c = clist(from);
    const r = c.getReader();
    r.getChanges(AdaptiveToken.top);
    transact(() => c.updateToArray(to));
    const changes = r.getChanges(AdaptiveToken.top);
    return { content: [...c], changes: changes.count };
  };

  it("removing the first of a thousand is one change", () => {
    const xs = Array.from({ length: 1000 }, (_, i) => i);
    expect(run(xs, xs.slice(1))).toEqual({ content: xs.slice(1), changes: 1 });
  });

  it("an insert in the middle is one change", () => {
    expect(run([1, 2, 3, 4], [1, 2, 9, 3, 4])).toEqual({ content: [1, 2, 9, 3, 4], changes: 1 });
  });

  it("agrees with the array under random edits", () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const c = clist<number>([]);
    const r = c.getReader();
    let shadow: number[] = [];
    for (let run = 0; run < 300; run++) {
      const next = shadow.slice();
      for (let k = 0; k < 1 + rnd(4); k++) {
        const op = rnd(3);
        if (op === 0 || next.length === 0) next.splice(rnd(next.length + 1), 0, rnd(10));
        else if (op === 1) next.splice(rnd(next.length), 1);
        else next[rnd(next.length)] = rnd(10);
      }
      transact(() => c.updateToArray(next));
      r.getChanges(AdaptiveToken.top);
      expect([...r.state]).toEqual(next);
      expect([...c]).toEqual(next);
      shadow = next;
    }
  });

  it("replaces a long list in place past the edit bound", () => {
    const xs = Array.from({ length: 3000 }, (_, i) => i);
    const ys = Array.from({ length: 2500 }, (_, i) => -i);
    expect(run(xs, ys)).toEqual({ content: ys, changes: 3000 });
  });

  it("keeps the ends around a long changed middle", () => {
    const xs = Array.from({ length: 3000 }, (_, i) => i);
    const ys = [...xs.slice(0, 10), ...xs.slice(10, 2990).map((x) => -x - 1), ...xs.slice(2990)];
    expect(run(xs, ys)).toEqual({ content: ys, changes: 2980 });
  });
});
