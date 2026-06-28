import { Folder, Loader2 } from "lucide-react";

export function ConnectingState() {
  return (
    <div className="flex flex-col items-center justify-center text-slate-400 py-20">
      <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
      Connecting to real-time orchestrator...
    </div>
  );
}

export function EmptyState() {
  return (
    <div className="text-center bg-slate-800/50 border border-dashed border-slate-700 rounded-3xl p-16 text-slate-400 flex flex-col items-center shadow-sm">
      <Folder className="w-12 h-12 text-slate-600 mb-4" />
      <p className="font-semibold text-slate-300">
        No PST files detected in staging.
      </p>
      <p className="text-sm mt-1">
        Place your files in the staging directory and run a scan.
      </p>
    </div>
  );
}
