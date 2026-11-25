// Sends traces and metrics to Application Insights when APPLICATIONINSIGHTS_CONNECTION_STRING
// is set (task 14); does nothing otherwise, as in local development and tests. Imported
// first by main.ts, so it is set up before anything it instruments is loaded.
import { nameService, queryStringScrubber } from "@agent-core/core/telemetry-scrub";
import { useAzureMonitor } from "@azure/monitor-opentelemetry";

if (process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]) {
  nameService("agentcore-worker");
  useAzureMonitor({
    // Only what the SDK measures itself; no request or response bodies are recorded.
    enableLiveMetrics: false,
    // Every trace up to 5 a second, a few in each second after that: Azure Monitor's own
    // default, said here so nobody takes samplingRatio for "keep all" (with a rate set,
    // it is not used). Raise tracesPerSecond, or set 0 to keep every trace, if a
    // deployment needs more and accepts the cost.
    tracesPerSecond: 5,
    // No query strings in traces (packages/core/src/telemetry-scrub.ts).
    spanProcessors: [queryStringScrubber as never],
  });
}
