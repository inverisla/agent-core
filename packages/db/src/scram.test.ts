import { describe, expect, it } from "vitest";
import { scramSha256Verifier } from "./scram.ts";

describe("scramSha256Verifier", () => {
  it("matches the RFC 7677 test vector's form and values", () => {
    // RFC 7677: password "pencil", salt W22ZaJ0SNY7soEsUEjb6gQ==, 4096 iterations.
    const v = scramSha256Verifier("pencil", Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64"));
    expect(v).toBe(
      "SCRAM-SHA-256$4096:W22ZaJ0SNY7soEsUEjb6gQ==$WG5d8oPm3OtcPnkdi4Uo7BkeZkBFzpcXkuLmtbsT4qY=:wfPLwcE6nTWhTAmQ7tl2KeoiWGPlZqQxSrmfPwDl2dU=",
    );
  });

  it("uses a fresh salt each time", () => {
    expect(scramSha256Verifier("x")).not.toBe(scramSha256Verifier("x"));
  });
});
