import { Database, FileText } from "lucide-react";
import type { TabKey } from "@/lib/types";

interface TabNavigationProps {
  activeTab: TabKey;
  onChange: (tab: TabKey) => void;
}

export function TabNavigation({ activeTab, onChange }: TabNavigationProps) {
  return (
    <div className="flex space-x-6 mb-8 border-b border-slate-800">
      <button
        type="button"
        onClick={() => onChange("pst")}
        className={`pb-3 border-b-2 font-bold text-sm tracking-wide transition-colors flex items-center gap-2 ${
          activeTab === "pst"
            ? "border-indigo-500 text-indigo-400"
            : "border-transparent text-slate-500 hover:text-slate-300"
        }`}
      >
        <Database className="w-4 h-4" />
        Email Archives (PST)
      </button>
      <button
        type="button"
        onClick={() => onChange("standalone")}
        className={`pb-3 border-b-2 font-bold text-sm tracking-wide transition-colors flex items-center gap-2 ${
          activeTab === "standalone"
            ? "border-emerald-500 text-emerald-400"
            : "border-transparent text-slate-500 hover:text-slate-300"
        }`}
      >
        <FileText className="w-4 h-4" />
        Standalone Docs & Teams
      </button>
    </div>
  );
}
