"use client";
// Shown when a page fails. Only a fixed message: the error itself is never displayed.
import { useEffect } from "react";
import { Alert, AppShell, Button, PageHeader } from "../components/ui/index.ts";

export default function ErrorPage({ reset }: { reset: () => void }) {
  useEffect(() => {
    document.title = "Something went wrong";
  }, []);
  return (
    <AppShell>
      <PageHeader title="Something went wrong" />
      <Alert tone="danger">This page could not be shown. Try again in a moment.</Alert>
      <Button type="button" variant="secondary" onClick={() => reset()}>
        Try again
      </Button>
    </AppShell>
  );
}
