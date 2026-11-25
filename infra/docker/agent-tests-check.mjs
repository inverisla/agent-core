// Run inside the worker image by CI: the worker must find the demo agent's test set
// (samples/, copied into the image) to run each new version's test set (task 16).
import { agentRegistry } from "@agent-core/core/agents";
import { testSetFor } from "@agent-core/testing";

const agent = (await agentRegistry(process.env)).get("contract-summary");
const dir = agent ? testSetFor(agent) : null;
if (!agent || !dir) {
  console.error("The worker image has no test set for the demo agent: is samples/ copied?");
  process.exit(1);
}
console.log(`contract-summary ${agent.version}: test set at ${dir}`);
