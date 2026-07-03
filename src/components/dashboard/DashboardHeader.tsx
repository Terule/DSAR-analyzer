import { Database, Eye, EyeOff, RefreshCw } from "lucide-react";

interface DashboardHeaderProps {
  showScanButton: boolean;
  isRefreshing: boolean;
  scanDisabled: boolean;
  onScan: () => void;
  privacyMode: boolean;
  onTogglePrivacy: () => void;
}

export function DashboardHeader({
  showScanButton,
  isRefreshing,
  scanDisabled,
  onScan,
  privacyMode,
  onTogglePrivacy,
}: DashboardHeaderProps) {
  return (
    <header className="mb-8 pb-6 flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-white flex items-center gap-3">
          <Database className="w-8 h-8 text-indigo-500" />
          DSAR Workspace
        </h1>
        <p className="text-slate-400 mt-2 font-medium">
          Automated data extraction, deduplication, and compliance filtering.
        </p>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onTogglePrivacy}
          aria-pressed={privacyMode}
          title={privacyMode ? "Show case names" : "Hide case names"}
          className={`inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm border shadow-sm transition-colors ${
            privacyMode
              ? "bg-indigo-500/15 border-indigo-500/40 text-indigo-300"
              : "bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700"
          }`}
        >
          {privacyMode ? (
            <EyeOff className="w-4 h-4" />
          ) : (
            <Eye className="w-4 h-4" />
          )}
          <span className="hidden sm:inline">
            {privacyMode ? "Hidden" : "Privacy"}
          </span>
        </button>

        {showScanButton && (
          <button
            type="button"
            disabled={scanDisabled}
            onClick={onScan}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 px-5 py-2.5 rounded-xl font-semibold text-sm border border-slate-700 shadow-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <RefreshCw
              className={`w-4 h-4 ${isRefreshing ? "animate-spin text-indigo-400" : ""}`}
            />
            {isRefreshing ? "Scanning Storage..." : "Scan PST Directory"}
          </button>
        )}
      </div>
    </header>
  );
}
