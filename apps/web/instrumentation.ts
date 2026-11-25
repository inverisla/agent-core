// Next.js calls register() once at start-up, and onRequestError() for every error a page,
// route or action did not handle (task 14).
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  // Traces and metrics to Application Insights, only where it is configured, and only on
  // the Node.js server (not the edge runtime).
  if (
    process.env["NEXT_RUNTIME"] === "nodejs" &&
    process.env["APPLICATIONINSIGHTS_CONNECTION_STRING"]
  ) {
    // Not a React hook, whatever its name says.
    const { useAzureMonitor: startAzureMonitor } = await import("@azure/monitor-opentelemetry");
    const { nameService, queryStringScrubber } = await import("@agent-core/core/telemetry-scrub");
    nameService("agentcore-web");
    startAzureMonitor({
      enableLiveMetrics: false,
      // Every trace up to 5 a second, a few in each second after that: Azure Monitor's own
      // default, said here so nobody takes samplingRatio for "keep all" (with a rate set,
      // it is not used). Raise tracesPerSecond, or set 0 to keep every trace, if a
      // deployment needs more and accepts the cost.
      tracesPerSecond: 5,
      // Request URLs can hold an email address and a sign-in token: never send them.
      spanProcessors: [queryStringScrubber as never],
    });
  }
}

/**
 * One event per unhandled error, by route pattern (/t/[slug]/documents), never the real
 * URL or the error's message, which can hold user input. The "web app errors" alert
 * counts these.
 */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env["NEXT_RUNTIME"] !== "nodejs") return;
  const { logEvent } = await import("@agent-core/core/telemetry");
  logEvent(
    "app.error",
    {
      route: context.routePath,
      kind: context.routeType,
      error: error instanceof Error ? error.name : "unknown",
      digest:
        typeof (error as { digest?: unknown }).digest === "string"
          ? (error as { digest: string }).digest
          : null,
    },
    "error",
  );
};
