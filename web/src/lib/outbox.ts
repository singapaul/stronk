/**
 * Writes made while offline wait here and replay in order once the connection is back.
 * Ops for the same set coalesce: completing then un-completing a set offline sends nothing,
 * and completing twice (edited numbers) sends only the latest.
 */
export type OutboxOp = {
  id: string;
  /** Which set row this op belongs to (a server set id, or a local id for added sets). */
  setKey: string;
  kind: "complete" | "uncomplete" | "create" | "delete" | "update";
  method: "POST" | "PATCH" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
  createdAt: number;
};

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const OPPOSITES: Record<string, string> = { complete: "uncomplete", uncomplete: "complete", create: "delete" };

/** What happened to one op when we tried to send it. */
export type SendResult = "ok" | "retry" | "drop";

export function createOutbox(store: KeyValueStore, key = "stronk.outbox") {
  const read = (): OutboxOp[] => {
    try {
      return JSON.parse(store.getItem(key) ?? "[]") as OutboxOp[];
    } catch {
      return [];
    }
  };
  const write = (ops: OutboxOp[]) => store.setItem(key, JSON.stringify(ops));

  return {
    list: read,
    pendingFor: (setKey: string) => read().some((op) => op.setKey === setKey),
    push(op: OutboxOp) {
      let ops = read();
      const lastForSet = [...ops].reverse().find((o) => o.setKey === op.setKey);
      if (lastForSet && OPPOSITES[lastForSet.kind] === op.kind) {
        // The two cancel out (e.g. tick then untick, or create then delete, before syncing).
        write(ops.filter((o) => o.id !== lastForSet.id));
        return;
      }
      if (lastForSet && lastForSet.kind === op.kind && (op.kind === "complete" || op.kind === "update")) {
        ops = ops.filter((o) => o.id !== lastForSet.id);
      }
      write([...ops, op]);
    },
    /**
     * Send ops oldest first. Stops at the first "retry" (still offline) so order is preserved;
     * "drop" discards an op the server rejected for good (e.g. 404/409).
     */
    async flush(send: (op: OutboxOp) => Promise<SendResult>): Promise<{ sent: number; remaining: number }> {
      let sent = 0;
      for (const op of read()) {
        const result = await send(op);
        if (result === "retry") break;
        write(read().filter((o) => o.id !== op.id));
        if (result === "ok") sent++;
      }
      return { sent, remaining: read().length };
    },
  };
}
export type Outbox = ReturnType<typeof createOutbox>;
