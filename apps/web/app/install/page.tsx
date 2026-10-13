import { Suspense } from "react";
import Install from "@/components/Install";

// Installing, waiting, done. The install travels in the page address, so
// a reload or a bookmark resumes the same install: progress is read from the
// project, not from the page.
export default function InstallPage() {
  return (
    <Suspense fallback={<main />}>
      <Install />
    </Suspense>
  );
}
