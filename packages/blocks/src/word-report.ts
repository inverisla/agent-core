// word-report: the agent's Word template filled in with the fields (docxtemplater).
// Placeholders are {field}, loops {#items}…{/items}; a field with no value is blank.
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import { cleanFields } from "./clean-fields.ts";
import { BlockError } from "./errors.ts";
import type { Fields } from "./extract-to-schema.ts";

export function wordReport(template: Uint8Array, fields: Fields): Buffer {
  try {
    const doc = new Docxtemplater(new PizZip(template), {
      paragraphLoop: true,
      linebreaks: true,
      nullGetter: () => "",
      // Its own error logging prints the template and the values to the console; tenant
      // content must never reach a log. Failures become template-error below.
      errorLogging: false,
    });
    // A character XML cannot hold (a page's form feed, say) would break the report.
    doc.render(cleanFields(fields));
    return doc.getZip().generate({ type: "nodebuffer", compression: "DEFLATE" });
  } catch {
    // A broken template (bad tags, not a Word file); the message can quote it.
    throw new BlockError("template-error");
  }
}
