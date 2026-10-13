import { Suspense } from "react";
import Flow from "@/components/Flow";

// Welcome, then the questions. Which screen is shown is read from the page
// address in the browser, so the page itself is the same for everyone.
// A sign-in that did not complete comes back here as /?error=<CODE>.
export default function Page() {
  return (
    <Suspense fallback={<main />}>
      <Flow />
    </Suspense>
  );
}
