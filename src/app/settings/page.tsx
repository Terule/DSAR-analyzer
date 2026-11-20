import { Suspense } from "react";
import { SettingsPage } from "@/components/aida/SettingsPage";

export default function Settings() {
  return (
    <Suspense>
      <SettingsPage />
    </Suspense>
  );
}
