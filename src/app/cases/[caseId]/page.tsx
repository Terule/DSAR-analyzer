import { Suspense } from "react";
import { CasePage } from "@/components/aida/CasePage";

export default async function Page({
  params,
}: {
  params: Promise<{ caseId: string }>;
}) {
  const { caseId } = await params;
  return (
    <Suspense>
      <CasePage caseId={caseId} />
    </Suspense>
  );
}
