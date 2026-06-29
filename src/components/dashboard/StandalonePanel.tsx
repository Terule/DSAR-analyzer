"use client";

import {
  AlertCircle,
  CheckCircle,
  FileText,
  Loader2,
  ShieldAlert,
} from "lucide-react";
import { useState } from "react";
import { runStandalone } from "@/lib/api";

export function StandalonePanel() {
  const [caseName, setCaseName] = useState("");
  const [subjectName, setSubjectName] = useState("");
  const [subjectAliases, setSubjectAliases] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<{
    processed: number;
    skipped: number;
    message: string;
  } | null>(null);
  const [error, setError] = useState("");

  const handleRun = async () => {
    if (!caseName.trim() || !subjectName.trim()) {
      setError("Case Name and Subject Full Name are required.");
      return;
    }
    setIsProcessing(true);
    setError("");
    setResults(null);
    try {
      const { ok, data } = await runStandalone({
        caseName: caseName.trim(),
        subjectCriteria: {
          name: subjectName.trim(),
          aliases: subjectAliases
            .split(",")
            .map((a) => a.trim())
            .filter(Boolean),
        },
      });
      if (ok && data.success)
        setResults({
          processed: data.processedCount ?? 0,
          skipped: data.skippedCount ?? 0,
          message: data.message ?? "",
        });
      else setError(data.error || "Failed to process standalone files.");
    } catch (_err) {
      setError("A network error occurred.");
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div className="bg-slate-800 rounded-3xl border border-slate-700 shadow-xl overflow-hidden">
      <div className="p-8 space-y-8">
        <div className="flex flex-col gap-2">
          <h2 className="text-2xl font-bold text-white flex items-center gap-3">
            <FileText className="w-7 h-7 text-emerald-400" />
            Hard-Filter Engine
          </h2>
          <p className="text-slate-400 text-sm">
            Process raw documents (PDF, DOCX, XLSX) and Teams Chats (HTML). This
            engine bypasses the AI and uses strict keyword rules to instantly
            discard privileged data and keep only files mentioning the Data
            Subject.
          </p>
        </div>

        <div className="bg-slate-900/60 border border-slate-700/60 rounded-xl p-5 flex items-start gap-4">
          <ShieldAlert className="w-6 h-6 text-amber-500 shrink-0 mt-0.5" />
          <div className="text-sm text-slate-300">
            <strong className="text-white block mb-1">
              Required Setup Instructions:
            </strong>
            Before running this filter, you must place the loose files or nested
            export folders into the following directory structure:
            <br />
            <code className="text-emerald-400 font-mono bg-slate-950 px-2 py-1 rounded mt-2 inline-block">
              /staging-area/standalone/[Case Name]/
            </code>
          </div>
        </div>

        <div className="space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label
                htmlFor="stdCaseName"
                className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
              >
                Case Name (Nested Path)
              </label>
              <input
                id="stdCaseName"
                type="text"
                value={caseName}
                onChange={(e) => setCaseName(e.target.value)}
                placeholder="e.g., MB/R2"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
            <div>
              <label
                htmlFor="stdSubjectName"
                className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
              >
                Subject Full Name
              </label>
              <input
                id="stdSubjectName"
                type="text"
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                placeholder="e.g., Jhon Doe"
                className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="stdSubjectAliases"
              className="block text-xs font-bold text-slate-400 uppercase tracking-wider mb-2"
            >
              Aliases (Comma Separated, Optional)
            </label>
            <input
              id="stdSubjectAliases"
              type="text"
              value={subjectAliases}
              onChange={(e) => setSubjectAliases(e.target.value)}
              placeholder="e.g., J. Doe, Johnny Doe"
              className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-sm text-white focus:outline-none focus:border-emerald-500 transition-colors"
            />
          </div>
        </div>

        {error && (
          <div className="bg-rose-500/10 border border-rose-500/20 text-rose-400 p-4 rounded-lg text-sm flex items-center gap-3">
            <AlertCircle className="w-5 h-5" />
            {error}
          </div>
        )}

        {results && (
          <div className="bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 p-6 rounded-lg flex flex-col gap-3">
            <div className="flex items-center gap-3 font-bold text-lg mb-2">
              <CheckCircle className="w-6 h-6" />
              Batch Processing Complete
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-emerald-950/30 p-4 rounded-xl border border-emerald-500/20">
                <span className="block text-xs text-emerald-500 uppercase font-bold mb-1">
                  Approved & Exported
                </span>
                <span className="text-2xl font-mono text-emerald-300">
                  {results.processed}
                </span>
              </div>
              <div className="bg-slate-900/50 p-4 rounded-xl border border-slate-700/50">
                <span className="block text-xs text-slate-500 uppercase font-bold mb-1">
                  Skipped / Excluded
                </span>
                <span className="text-2xl font-mono text-slate-300">
                  {results.skipped}
                </span>
              </div>
            </div>
            <p className="text-xs text-emerald-500 mt-2">
              Deliverables securely flattened and saved to: <br />
              <code className="font-mono bg-emerald-950 px-1 py-0.5 rounded border border-emerald-900 mt-1 inline-block">
                /extracted_emails/{caseName}/Messages/
              </code>
              <br />
              <code className="font-mono bg-emerald-950 px-1 py-0.5 rounded border border-emerald-900 mt-1 inline-block">
                /extracted_emails/{caseName}/Documents/
              </code>
            </p>
          </div>
        )}

        <div className="pt-4 border-t border-slate-700/50">
          <button
            type="button"
            disabled={isProcessing || !caseName || !subjectName}
            onClick={handleRun}
            className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white px-6 py-4 rounded-2xl font-bold text-sm transition-all shadow-lg shadow-emerald-900/20 flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" /> Processing
                Hard-Filter...
              </>
            ) : (
              <>
                <FileText className="w-5 h-5" /> Launch Standalone Pipeline
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
