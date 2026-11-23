/**
 * Supersets are logged as rounds: blocks that share a superset group become one card, and their
 * working sets interleave (round 1 = A1 set 1, A2 set 1; round 2 = the set 2s...). Warm-ups come
 * first. Exercises outside a superset are a card of their own. Pure, so it's unit-tested.
 */

export type RoundRow = { key: string; type: string; done: boolean };
export type RoundBlock = { superset: number | null; rows: RoundRow[] };

export type Entry = { block: number; row: string };
export type Round = { label: string; entries: Entry[] };

export type Group =
  | { kind: "single"; block: number; rounds: Round[] }
  | { kind: "superset"; letter: string; members: { block: number; tag: string }[]; rounds: Round[] };

/** 1 → "A", 2 → "B"... (matches the A1/A2 notes in routines); beyond Z, the number. */
export const supersetLetter = (group: number) => (group >= 1 && group <= 26 ? String.fromCharCode(64 + group) : String(group));

function splitRows(rows: RoundRow[]) {
  return { warm: rows.filter((r) => r.type === "warmup"), work: rows.filter((r) => r.type !== "warmup") };
}

export function groupBlocks(blocks: RoundBlock[]): Group[] {
  const groups: Group[] = [];
  const seen = new Map<number, Extract<Group, { kind: "superset" }>>();
  blocks.forEach((b, i) => {
    if (b.superset == null) {
      const { warm, work } = splitRows(b.rows);
      const rounds: Round[] = [];
      if (warm.length) rounds.push({ label: "Warm-up", entries: warm.map((r) => ({ block: i, row: r.key })) });
      work.forEach((r, n) => rounds.push({ label: `Set ${n + 1}`, entries: [{ block: i, row: r.key }] }));
      groups.push({ kind: "single", block: i, rounds });
      return;
    }
    let g = seen.get(b.superset);
    if (!g) {
      g = { kind: "superset", letter: supersetLetter(b.superset), members: [], rounds: [] };
      seen.set(b.superset, g);
      groups.push(g);
    }
    g.members.push({ block: i, tag: `${g.letter}${g.members.length + 1}` });
  });
  // Build superset rounds once all members are known.
  for (const g of seen.values()) {
    const split = g.members.map((m) => splitRows(blocks[m.block]!.rows));
    const warm: Entry[] = g.members.flatMap((m, j) => split[j]!.warm.map((r) => ({ block: m.block, row: r.key })));
    if (warm.length) g.rounds.push({ label: "Warm-up", entries: warm });
    const most = Math.max(0, ...split.map((s) => s.work.length));
    for (let n = 0; n < most; n++) {
      const entries = g.members.flatMap((m, j) => {
        const r = split[j]!.work[n];
        return r ? [{ block: m.block, row: r.key }] : [];
      });
      g.rounds.push({ label: `Round ${n + 1}`, entries });
    }
  }
  return groups;
}

/** Every entry in the order you do them: group by group, round by round, member by member. */
export const order = (groups: Group[]): Entry[] => groups.flatMap((g) => g.rounds.flatMap((r) => r.entries));

/**
 * What's next after ticking `after` (or overall when omitted): the next undone entry in order,
 * wrapping to the first undone one if everything after it is done. Null when all are done.
 */
export function nextUp(groups: Group[], blocks: RoundBlock[], after?: Entry): Entry | null {
  const all = order(groups);
  const isDone = (e: Entry) => blocks[e.block]?.rows.find((r) => r.key === e.row)?.done ?? true;
  const start = after ? all.findIndex((e) => e.block === after.block && e.row === after.row) + 1 : 0;
  return all.slice(start).find((e) => !isDone(e)) ?? all.slice(0, start).find((e) => !isDone(e)) ?? null;
}
