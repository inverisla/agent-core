// Checks the worker image has system root certificates. Temporal's native client reads
// them (not Node's bundled copy) for TLS, so without them the worker cannot reach
// Temporal Cloud ("NativeCertsNotFound"). Run inside the image from apps/worker:
//   docker run --rm -v "$PWD/infra/docker/tls-check.mjs:/app/apps/worker/tls-check.mjs" \
//     -w /app/apps/worker agentcore-worker node tls-check.mjs
// It connects with TLS to a closed local port: the certificates are loaded before the
// connection is tried, so a connection error means they were found.
import { NativeConnection } from "@temporalio/worker";

try {
  await NativeConnection.connect({ address: "127.0.0.1:1", tls: true });
  console.error("tls-check: unexpectedly connected to 127.0.0.1:1");
  process.exit(1);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("NativeCertsNotFound")) {
    console.error("tls-check: the image has no system root certificates");
    process.exit(1);
  }
  // Only the expected failure counts: the connection to the closed port was refused.
  if (!/tcp connect error|ConnectionRefused|Connection refused/i.test(message)) {
    console.error(`tls-check: unexpected error: ${message}`);
    process.exit(1);
  }
  console.log("tls-check: system root certificates found");
}
