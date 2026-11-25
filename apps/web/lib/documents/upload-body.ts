// Reading an upload's body safely: bytes are counted as they arrive and reading stops as
// soon as the limit is passed, whether or not the request declared a length (chunked
// uploads do not), or once the body stalls or crawls (a body trickled in slowly would
// otherwise hold its slot for ever). Each instance runs only a few uploads at once, and
// no tenant takes more than half of them, so one tenant cannot block everyone else's
// uploads (review S5). Memory stays bounded: about MAX_CONCURRENT_UPLOADS x (limit x 2).

export const MAX_CONCURRENT_UPLOADS = 4;
/** Of those, at most this many for one tenant. */
export const MAX_UPLOADS_PER_TENANT_AT_ONCE = 2;
/**
 * When an upload is given up as too slow: nothing has arrived for idleMs; or, after
 * graceMs, it has averaged under minBytesPerSecond (so a byte every few seconds cannot
 * hold a slot); or it has taken maxMs in all. A slow but steady connection passes:
 * 20 MB at 64 KB/s takes about 5 minutes.
 */
export interface UploadPace {
  idleMs: number;
  graceMs: number;
  minBytesPerSecond: number;
  maxMs: number;
}
export const UPLOAD_PACE: UploadPace = {
  idleMs: 30_000,
  graceMs: 30_000,
  minBytesPerSecond: 8 * 1024,
  maxMs: 15 * 60_000,
};
/** Room for the multipart boundaries and headers around the file itself. */
export const FORM_OVERHEAD_BYTES = 64 * 1024;

let running = 0;
const perTenant = new Map<string, number>();

/**
 * Runs fn if an upload slot is free, for this instance and for the tenant; otherwise
 * returns null without running it.
 */
export async function withUploadSlot<T>(tenantId: string, fn: () => Promise<T>): Promise<T | null> {
  const mine = perTenant.get(tenantId) ?? 0;
  if (running >= MAX_CONCURRENT_UPLOADS || mine >= MAX_UPLOADS_PER_TENANT_AT_ONCE) return null;
  running++;
  perTenant.set(tenantId, mine + 1);
  try {
    return await fn();
  } finally {
    running--;
    const left = (perTenant.get(tenantId) ?? 1) - 1;
    if (left > 0) perTenant.set(tenantId, left);
    else perTenant.delete(tenantId);
  }
}

/**
 * The body; "too-large" if it passes limitBytes, or "too-slow" if it stalls or crawls
 * (UploadPace). Reading stops at either.
 */
export async function readBodyWithin(
  req: Request,
  limitBytes: number,
  pace: UploadPace = UPLOAD_PACE,
  clock: () => number = Date.now,
): Promise<Buffer | "too-large" | "too-slow"> {
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  // Not awaited: a stalled client may never let the cancel finish.
  const stop = () => void reader.cancel().catch(() => {});
  const chunks: Uint8Array[] = [];
  let total = 0;
  const started = clock();
  for (;;) {
    const wait = Math.min(pace.idleMs, pace.maxMs - (clock() - started));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, wait));
    });
    const next = await Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
    if (next === "late") {
      stop();
      return "too-slow";
    }
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limitBytes) {
      stop();
      return "too-large";
    }
    chunks.push(next.value);
    const ms = clock() - started;
    if (ms >= pace.maxMs || (ms > pace.graceMs && (total * 1000) / ms < pace.minBytesPerSecond)) {
      stop();
      return "too-slow";
    }
  }
  return Buffer.concat(chunks);
}
