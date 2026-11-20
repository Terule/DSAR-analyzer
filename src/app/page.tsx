import { Suspense } from "react";
import { CasesPage } from "@/components/aida/CasesPage";

export default function Home() {
  return (
    <Suspense>
      <CasesPage />
    </Suspense>
  );
}
