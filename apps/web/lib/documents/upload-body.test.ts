import { describe, expect, it } from "vitest";
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOADS_PER_TENANT_AT_ONCE,
  readBodyWithin,
  withUploadSlot,
} from "./upload-body.ts";

const CHUNK = 16 * 1024;

/** A request whose body never ends, counting the bytes the reader pulls. */
function endlessRequest() {
  const pulled = { bytes: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled.bytes += CHUNK;
      controller.enqueue(new Uint8Array(CHUNK));
    },
  });
  const req = new Request("http://localhost/upload", {
    method: "POST",
    body,
    duplex: "half",
  } as RequestInit);
  return { req, pulled };
}

describe("readBodyWithin", () => {
  it("stops reading an endless body just past the limit", async () => {
    const limit = 100 * 1024;
    const { req, pulled } = endlessRequest();
    expect(await readBodyWithin(req, limit)).toBe("too-large");
    // The limit plus the chunk that crossed it, and at most a little read-ahead.
    expect(pulled.bytes).toBeLessThanOrEqual(limit + 3 * CHUNK);
  });

  it("returns a body within the limit whole", async () => {
    const bytes = new Uint8Array(1000).fill(7);
    const req = new Request("http://localhost/upload", { method: "POST", body: bytes });
    const body = await readBodyWithin(req, 1000);
    expect(Buffer.isBuffer(body) && body.equals(Buffer.from(bytes))).toBe(true);
  });

  it("refuses a body one byte over the limit", async () => {
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body: new Uint8Array(1001),
    });
    expect(await readBodyWithin(req, 1000)).toBe("too-large");
  });
});

describe("upload limits (review S5)", () => {
  it("stops waiting for a body that trickles in too slowly", async () => {
    // A body that sends one byte and then nothing.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1));
      },
    });
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    const pace = { idleMs: 50, graceMs: 1000, minBytesPerSecond: 1, maxMs: 60_000 };
    expect(await readBodyWithin(req, 1000, pace)).toBe("too-slow");
  });

  // A body sent in 10-byte chunks, and a clock that moves msPerChunk for each.
  const paced = (chunks: number, msPerChunk: number) => {
    let now = 0;
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((r) => setTimeout(r, 1));
        now += msPerChunk;
        if (sent++ < chunks) controller.enqueue(new Uint8Array(10));
        else controller.close();
      },
    });
    const req = new Request("http://localhost/upload", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit);
    return { req, clock: () => now };
  };

  it("refuses a body that keeps arriving, but too slowly on average", async () => {
    // 10 bytes a second: never idle, but under the minimum once the grace has passed.
    const { req, clock } = paced(100, 1000);
    const pace = { idleMs: 60_000, graceMs: 5000, minBytesPerSecond: 100, maxMs: 600_000 };
    expect(await readBodyWithin(req, 10_000, pace, clock)).toBe("too-slow");
  });

  it("refuses a body that takes longer than the most allowed in all", async () => {
    const { req, clock } = paced(100, 1000);
    const pace = { idleMs: 60_000, graceMs: 600_000, minBytesPerSecond: 0, maxMs: 20_000 };
    expect(await readBodyWithin(req, 10_000, pace, clock)).toBe("too-slow");
  });

  it("accepts a slow but steady body", async () => {
    // 10 bytes every 10 ms: 1000 bytes a second, over the 500 needed.
    const { req, clock } = paced(50, 10);
    const pace = { idleMs: 60_000, graceMs: 100, minBytesPerSecond: 500, maxMs: 600_000 };
    const body = await readBodyWithin(req, 10_000, pace, clock);
    expect(Buffer.isBuffer(body) && body.length).toBe(500);
  });

  it("gives one tenant at most half the upload slots", async () => {
    const release: (() => void)[] = [];
    const hold = (tenant: string) =>
      withUploadSlot(tenant, () => new Promise<string>((done) => release.push(() => done(tenant))));
    const a = [1, 2].map(() => hold("a"));
    // A third for tenant a is refused at once; tenant b still gets in.
    expect(await withUploadSlot("a", async () => "third")).toBeNull();
    const b = hold("b");
    expect(MAX_UPLOADS_PER_TENANT_AT_ONCE).toBeLessThan(MAX_CONCURRENT_UPLOADS);
    for (const r of release) r();
    expect(await Promise.all([...a, b])).toEqual(["a", "a", "b"]);
    // Released: tenant a can upload again.
    expect(await withUploadSlot("a", async () => "again")).toBe("again");
  });
});
