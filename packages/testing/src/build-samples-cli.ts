// pnpm samples:build: writes each sample's PDF or Word file from its source, and the demo
// agent's template. The files are committed; a test fails if they are out of date.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSample, loadSamples, SAMPLES_DIR } from "./samples.ts";
import { buildContractSummaryTemplate, TEMPLATE_PATH } from "./template.ts";

mkdirSync(path.join(SAMPLES_DIR, "files"), { recursive: true });
for (const sample of loadSamples()) {
  writeFileSync(path.join(SAMPLES_DIR, sample.file), buildSample(sample));
  console.log(`samples/${sample.file}`);
}
writeFileSync(TEMPLATE_PATH, buildContractSummaryTemplate());
console.log(path.relative(path.join(SAMPLES_DIR, ".."), TEMPLATE_PATH));
