import { createOutbox, type OutboxOp, type SendResult } from "./lib/outbox.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

/** Fired when the session has gone (the app shows the sign-in screen). */
export const UNAUTHORIZED_EVENT = "stronk:unauthorized";
/** Fired whenever the outbox changes (the app shows the "waiting to sync" banner). */
export const OUTBOX_EVENT = "stronk:outbox";

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      "x-stronk-client": "web",
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText, data?.details);
  return data as T;
}

export const outbox = createOutbox(window.localStorage);
const notify = () => window.dispatchEvent(new Event(OUTBOX_EVENT));

async function send(op: OutboxOp): Promise<{ result: SendResult; data?: unknown }> {
  try {
    const data = await api(op.method, op.path, op.body);
    return { result: "ok", data };
  } catch (err) {
    if (err instanceof ApiError) {
      // Rate limited or server trouble: try again later. Other client errors won't get better.
      return { result: err.status === 429 || err.status >= 500 ? "retry" : "drop" };
    }
    return { result: "retry" }; // network error: offline
  }
}

let flushing: Promise<unknown> | null = null;
export function flushOutbox() {
  flushing ??= outbox
    .flush(async (op) => (await send(op)).result)
    .finally(() => {
      flushing = null;
      notify();
    });
  return flushing;
}

/**
 * Send a write now; if we're offline, queue it and resolve with null so the UI can mark the set
 * as waiting to sync. Errors from the server (validation, conflicts) are thrown.
 */
export async function writeOrQueue<T>(op: Omit<OutboxOp, "id" | "createdAt">): Promise<T | null> {
  const full: OutboxOp = { ...op, id: crypto.randomUUID(), createdAt: Date.now() };
  if (navigator.onLine && outbox.list().length === 0) {
    try {
      return await api<T>(op.method, op.path, op.body);
    } catch (err) {
      if (err instanceof ApiError && err.status !== 429 && err.status < 500) throw err;
    }
  }
  outbox.push(full);
  notify();
  return null;
}

window.addEventListener("online", () => void flushOutbox());
setInterval(() => {
  if (navigator.onLine && outbox.list().length > 0) void flushOutbox();
}, 15_000);
