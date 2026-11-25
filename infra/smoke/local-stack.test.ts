// Checks that each service from `docker compose up` is reachable and usable.
// This is task 1's done-when test: it runs as part of `pnpm test`, locally and in CI.
import { randomUUID } from "node:crypto";
import { BlobServiceClient } from "@azure/storage-blob";
import { Connection } from "@temporalio/client";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { START_HINT, stackEnv } from "./env.ts";

async function withHint<T>(service: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`${service} check failed. ${START_HINT}`, { cause: error });
  }
}

describe("local stack", () => {
  it("Postgres accepts connections and runs queries", async () => {
    const sql = postgres(stackEnv.databaseUrl, { connect_timeout: 5, max: 1 });
    try {
      const rows = await withHint(
        "Postgres",
        () => sql<{ version: string }[]>`select current_setting('server_version') as version`,
      );
      expect(rows[0]?.version).toMatch(/^17\./);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("Temporal dev server answers and has the default namespace", async () => {
    const connection = await withHint("Temporal", () =>
      Connection.connect({ address: stackEnv.temporalAddress, connectTimeout: "5s" }),
    );
    try {
      const response = await withHint("Temporal", () =>
        connection.workflowService.describeNamespace({ namespace: stackEnv.temporalNamespace }),
      );
      expect(response.namespaceInfo?.name).toBe(stackEnv.temporalNamespace);
    } finally {
      await connection.close();
    }
  });

  it("Azurite stores and returns a blob", async () => {
    const service = BlobServiceClient.fromConnectionString(stackEnv.storageConnectionString);
    const container = service.getContainerClient(`smoke-${randomUUID()}`);
    await withHint("Azurite", () => container.create());
    try {
      const blob = container.getBlockBlobClient("hello.txt");
      const body = "hello from agent core";
      await blob.upload(body, Buffer.byteLength(body));
      const downloaded = await blob.downloadToBuffer();
      expect(downloaded.toString("utf8")).toBe(body);
    } finally {
      await container.delete();
    }
  });
});
