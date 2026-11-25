import { describe, expect, it } from "vitest";
import { cleanFilename, detectType, DOCX, PDF } from "./file-type.ts";
import {
  makeDocm,
  makeDocx,
  makeDocxWithHiddenMacros,
  makeDotx,
  makeExe,
  makeFakeDocxZips,
  makeOleFile,
  makePdf,
  makeZip,
} from "./test-files.ts";
import { makeHiddenPartDocx } from "@agent-core/blocks/testing";

describe("detectType", () => {
  it("recognises PDF and Word by content, compressed or not", () => {
    expect(detectType(makePdf())).toBe(PDF);
    expect(detectType(makeDocx())).toBe(DOCX);
    expect(detectType(makeDocx("plain", { deflate: false }))).toBe(DOCX);
  });

  it("accepts a Word document whose text mentions macro part names", () => {
    expect(detectType(makeDocx("see word/vbaProject.bin", { deflate: false }))).toBe(DOCX);
  });

  it("refuses macro-enabled documents and templates", () => {
    expect(detectType(makeDocm())).toBeNull();
    expect(detectType(makeDocxWithHiddenMacros())).toBeNull();
    expect(detectType(makeDotx())).toBeNull();
  });

  it("refuses zips that only mention Word's part names", () => {
    for (const zip of makeFakeDocxZips()) expect(detectType(zip)).toBeNull();
  });

  it("names old .doc and password-protected files separately", () => {
    expect(detectType(makeOleFile())).toBe("protected-or-legacy");
  });

  it("refuses everything else, whatever it is called", () => {
    expect(detectType(makeExe())).toBeNull();
    expect(detectType(makeZip({ "readme.txt": "hello" }))).toBeNull();
    expect(detectType(Buffer.from("just text"))).toBeNull();
    expect(detectType(Buffer.from(" %PDF-1.4 not at the start"))).toBeNull();
    expect(detectType(Buffer.alloc(0))).toBeNull();
  });
});

describe("cleanFilename", () => {
  it("keeps the name only, without paths or control characters", () => {
    expect(cleanFilename("C:\\Users\\x\\contract.pdf", PDF)).toBe("contract.pdf");
    expect(cleanFilename("../../etc/passwd", PDF)).toBe("passwd.pdf");
    expect(cleanFilename("con\u0000tr\u001bact\n.pdf", PDF)).toBe("contract.pdf");
  });

  it("removes text-direction tricks and makes the extension match the real type", () => {
    expect(cleanFilename("contract\u202Efdp.exe", PDF)).toBe("contractfdp.pdf");
    expect(cleanFilename("terms.pdf", DOCX)).toBe("terms.docx");
    expect(cleanFilename("notes", PDF)).toBe("notes.pdf");
  });

  it("limits the length without splitting characters", () => {
    expect(cleanFilename("x".repeat(300), PDF)).toHaveLength(200);
    const emoji = cleanFilename("😀".repeat(300), PDF);
    expect(Array.from(emoji)).toHaveLength(200);
    expect(emoji.endsWith(".pdf")).toBe(true);
  });

  it("gives a default when nothing is left", () => {
    expect(cleanFilename("\u0001\u0002", PDF)).toBe("document.pdf");
    expect(cleanFilename("", DOCX)).toBe("document.docx");
  });

  it("refuses a Word file whose zip hides a part from its end record (as the worker does)", () => {
    expect(detectType(makeHiddenPartDocx(1))).toBeNull();
  });
});
