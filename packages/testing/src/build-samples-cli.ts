// pnpm samples:build: writes each sample's PDF or Word file from its source, the demo
// agents' templates, and the risk agent's test set documents (copies of the samples).
// The files are committed; a test fails if they are out of date.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSample, loadSamples, RISK_TESTS_DIR, SAMPLES_DIR } from "./samples.ts";
import {
  buildContractRiskTemplate,
  buildContractSummaryTemplate,
  RISK_TEMPLATE_PATH,
  TEMPLATE_PATH,
} from "./template.ts";

mkdirSync(path.join(SAMPLES_DIR, "files"), { recursive: true });
for (const sample of loadSamples()) {
  writeFileSync(path.join(SAMPLES_DIR, sample.file), buildSample(sample));
  console.log(`samples/${sample.file}`);
}
const root = path.join(SAMPLES_DIR, "..");
writeFileSync(TEMPLATE_PATH, buildContractSummaryTemplate());
console.log(path.relative(root, TEMPLATE_PATH));
writeFileSync(RISK_TEMPLATE_PATH, buildContractRiskTemplate());
console.log(path.relative(root, RISK_TEMPLATE_PATH));
// The risk agent's test set is the same ten contracts, as the same files.
mkdirSync(path.join(RISK_TESTS_DIR, "files"), { recursive: true });
for (const sample of loadSamples()) {
  const copy = path.join(RISK_TESTS_DIR, sample.file);
  copyFileSync(path.join(SAMPLES_DIR, sample.file), copy);
  console.log(path.relative(root, copy));
}
