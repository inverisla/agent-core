// Run inside the worker image by CI: the worker must find each demo agent's test set to
// run each new version's test set (task 16): samples/ for the contract summary, copied
// into the image, and the risk review's own tests/ folder, copied with agents/ (task 17).
import { agentRegistry } from "@agent-core/core/agents";
import { testSetFor } from "@agent-core/testing";

const registry = await agentRegistry(process.env);
for (const name of ["contract-summary", "contract-risk"]) {
  const agent = registry.get(name);
  const dir = agent ? testSetFor(agent) : null;
  if (!agent || !dir) {
    console.error(`The worker image has no test set for ${name}: are samples/ and agents/ copied?`);
    process.exit(1);
  }
  console.log(`${name} ${agent.version}: test set at ${dir}`);
}
