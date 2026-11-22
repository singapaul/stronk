import { describe, expect, test } from "bun:test";
import { createOutbox, type OutboxOp } from "../../web/src/lib/outbox.ts";
import { describePast, describeTarget, lastFor, prefill } from "../../web/src/lib/prefill.ts";
import { adjustRest, formatClock, remainingS, startRest } from "../../web/src/lib/timer.ts";

describe("rest timer", () => {
  test("counts down from an end timestamp and survives time passing", () => {
    const t = startRest(1_000_000, 90, "Bench");
    expect(remainingS(t, 1_000_000)).toBe(90);
    expect(remainingS(t, 1_000_000 + 30_500)).toBe(60);
    expect(remainingS(t, 1_000_000 + 999_999)).toBe(0);
    expect(startRest(0, null, "x").total).toBe(120);
  });

  test("±15s adjusts and never goes negative", () => {
    const t = startRest(0, 60, "x");
    expect(remainingS(adjustRest(t, 15, 0), 0)).toBe(75);
    expect(remainingS(adjustRest(t, -90, 10_000), 10_000)).toBe(0);
  });

  test("formats clocks", () => {
    expect(formatClock(95)).toBe("1:35");
    expect(formatClock(5)).toBe("0:05");
    expect(formatClock(3725)).toBe("1:02:05");
  });
});

describe("prefill", () => {
  const t = { reps_min: 5, reps_max: 8, weight_kg: 80, rpe: 8, duration_s: null, distance_m: null };
  test("starts inputs at the target weight and the top of the rep range", () => {
    expect(prefill(t)).toEqual({ kg: 80, reps: 8, duration_s: null });
    expect(prefill(null)).toEqual({ kg: null, reps: null, duration_s: null });
  });

  test("describes targets", () => {
    expect(describeTarget(t)).toBe("80×5-8 @8");
    expect(describeTarget({ ...t, reps_max: 5, rpe: null })).toBe("80×5");
    expect(describeTarget({ ...t, weight_kg: null, rpe: null })).toBe("×5-8");
    expect(describeTarget({ reps_min: null, reps_max: null, weight_kg: null, rpe: null, duration_s: 60, distance_m: null })).toBe("60s");
    expect(describeTarget(null)).toBe("");
  });

  test("matches last time by set number, falling back to the last set of the same kind", () => {
    const prev = [
      { set_number: 1, type: "warmup", reps: 10, weight_kg: 40 },
      { set_number: 2, type: "normal", reps: 8, weight_kg: 80 },
      { set_number: 3, type: "normal", reps: 7, weight_kg: 80 },
    ];
    expect(describePast(lastFor(prev, 2, "normal"))).toBe("80×8");
    expect(describePast(lastFor(prev, 5, "normal"))).toBe("80×7");
    expect(describePast(lastFor([], 1, "normal"))).toBe("—");
  });
});

describe("outbox", () => {
  const memory = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };
  let n = 0;
  const op = (setKey: string, kind: OutboxOp["kind"], body?: unknown): OutboxOp => ({
    id: String(++n),
    setKey,
    kind,
    method: kind === "delete" ? "DELETE" : "POST",
    path: `/api/sets/${setKey}/${kind}`,
    body,
    createdAt: n,
  });

  test("tick then untick before syncing cancels out; a re-tick keeps only the latest numbers", () => {
    const box = createOutbox(memory());
    box.push(op("5", "complete", { reps: 8 }));
    box.push(op("5", "uncomplete"));
    expect(box.list()).toEqual([]);
    box.push(op("6", "complete", { reps: 8 }));
    box.push(op("6", "complete", { reps: 6 }));
    expect(box.list().map((o) => o.body)).toEqual([{ reps: 6 }]);
    box.push(op("local-1", "create"));
    box.push(op("local-1", "delete"));
    expect(box.list().map((o) => o.setKey)).toEqual(["6"]);
  });

  test("flushes in order, stops while offline, drops rejected ops", async () => {
    const box = createOutbox(memory());
    box.push(op("1", "complete"));
    box.push(op("2", "complete"));
    box.push(op("3", "complete"));
    const seen: string[] = [];
    let offline = true;
    const send = async (o: OutboxOp) => {
      seen.push(o.setKey);
      if (offline) return "retry" as const;
      return o.setKey === "2" ? ("drop" as const) : ("ok" as const);
    };
    expect(await box.flush(send)).toEqual({ sent: 0, remaining: 3 });
    offline = false;
    expect(await box.flush(send)).toEqual({ sent: 2, remaining: 0 });
    expect(seen).toEqual(["1", "1", "2", "3"]);
  });

  test("survives corrupt storage", () => {
    const store = memory();
    store.setItem("stronk.outbox", "{not json");
    expect(createOutbox(store).list()).toEqual([]);
  });
});
