// Tests only: a page that fails, so the end-to-end tests can check the error page. It
// exists only where ALLOW_TEST_FAULTS is "true" on a developer's own machine (review S18);
// elsewhere it is not found.
import { notLocalReason } from "@agent-core/core/local";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function FailingPage() {
  if (process.env["ALLOW_TEST_FAULTS"] !== "true" || notLocalReason(process.env)) notFound();
  throw new Error("test fault: this page fails on purpose");
}
