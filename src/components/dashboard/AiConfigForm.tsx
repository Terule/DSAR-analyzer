"use client";

import { useState } from "react";
import type { AiConfig } from "@/lib/types";

interface AiConfigFormProps {
  caseName: string;
  onCancel: () => void;
  onSubmit: (config: AiConfig) => void;
}

export function AiConfigForm({
  caseName,
  onCancel,
  onSubmit,
}: AiConfigFormProps) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [personalEmail, setPersonalEmail] = useState("");
  const [aliases, setAliases] = useState("");

  const canLaunch = name.trim().length > 0 && email.trim().length > 0;

  const handleLaunch = () => {
    if (!canLaunch) return;
    onSubmit({
      name: name.trim(),
      email: email.trim(),
      personalEmail: personalEmail.trim() || undefined,
      aliases: aliases
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    });
  };

  return (
    <div className="w-full bg-slate-900 border border-slate-700 rounded-2xl p-6 mb-8 shadow-inner">
      <h4 className="text-sm font-bold text-slate-200 mb-4">
        Target Subject Criteria
      </h4>
      <div className="space-y-4">
        <div>
          <label
            htmlFor={`name-${caseName}`}
            className="block text-xs font-bold text-slate-400 uppercase mb-1.5"
          >
            Full Name (Required)
          </label>
          <input
            id={`name-${caseName}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Jhon Doe"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:border-indigo-500 outline-none transition-colors"
          />
        </div>
        <div>
          <label
            htmlFor={`email-${caseName}`}
            className="block text-xs font-bold text-slate-400 uppercase mb-1.5"
          >
            Primary Email (Required)
          </label>
          <input
            id={`email-${caseName}`}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="e.g. jhon.doe@example.com"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:border-indigo-500 outline-none transition-colors"
          />
        </div>
        <div>
          <label
            htmlFor={`personal-email-${caseName}`}
            className="block text-xs font-bold text-slate-400 uppercase mb-1.5"
          >
            Personal Email (Optional)
          </label>
          <input
            id={`personal-email-${caseName}`}
            type="email"
            value={personalEmail}
            onChange={(e) => setPersonalEmail(e.target.value)}
            placeholder="e.g. jhon.doe@gmail.com"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:border-indigo-500 outline-none transition-colors"
          />
        </div>
        <div>
          <label
            htmlFor={`aliases-${caseName}`}
            className="block text-xs font-bold text-slate-400 uppercase mb-1.5"
          >
            Aliases (Comma separated)
          </label>
          <input
            id={`aliases-${caseName}`}
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="e.g. J. Doe, Johnny Doe"
            className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-sm text-white focus:border-indigo-500 outline-none transition-colors"
          />
        </div>
        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 bg-slate-800 border border-slate-700 hover:bg-slate-700 text-slate-300 font-semibold py-3 rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleLaunch}
            disabled={!canLaunch}
            className="flex-1 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl transition-colors shadow-lg shadow-indigo-900/20"
          >
            Launch Audit
          </button>
        </div>
      </div>
    </div>
  );
}
