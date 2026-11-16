"use client";

import { Loader2, Pencil, Plus, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface FormSummary {
  id: string;
  name: string;
  templateId: string;
}

interface Draft {
  id: string | null;
  name: string;
  templateId: string;
  apiToken: string;
}

const fieldClass =
  "w-full min-w-0 rounded-xl border border-slate-600 bg-slate-950/80 px-3 py-2.5 text-sm text-slate-100 outline-none transition focus:border-indigo-400 focus:ring-2 focus:ring-indigo-400/30";

/**
 * Saved OneTrust web forms. Each is saved on its own (not with the dialog's
 * Save button). Once saved, only the name shows; the pencil reopens the three
 * fields. The token is never sent back, so editing leaves it blank to keep it.
 */
export function OneTrustForms() {
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/onetrust-forms", {
        cache: "no-store",
      });
      const body = (await response.json()) as { forms?: FormSummary[] };
      setForms(body.forms ?? []);
    } catch {
      toast.error("Could not load the OneTrust web forms.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    try {
      const response = await fetch(
        draft.id ? `/api/onetrust-forms/${draft.id}` : "/api/onetrust-forms",
        {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: draft.name,
            templateId: draft.templateId,
            apiToken: draft.apiToken,
          }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok) throw new Error(body.error || "Could not save.");
      setDraft(null);
      await load();
      toast.success("Web form saved.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!draft?.id) return;
    if (!window.confirm(`Delete the web form "${draft.name}"?`)) return;
    setBusy(true);
    try {
      await fetch(`/api/onetrust-forms/${draft.id}`, { method: "DELETE" });
      setDraft(null);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const canSave =
    Boolean(draft?.name.trim()) &&
    Boolean(draft?.templateId.trim()) &&
    (Boolean(draft?.id) || Boolean(draft?.apiToken.trim()));

  const field = (
    label: string,
    key: "name" | "templateId" | "apiToken",
    options: { secret?: boolean; placeholder?: string } = {},
  ) => (
    <label className="grid min-w-0 content-start gap-2">
      <span className="text-sm font-semibold text-slate-200">{label}</span>
      <input
        type={options.secret ? "password" : "text"}
        name={options.secret ? "onetrust-form-token-replacement" : undefined}
        autoComplete={options.secret ? "new-password" : "off"}
        data-lpignore="true"
        value={draft?.[key] ?? ""}
        placeholder={options.placeholder}
        onChange={(event) =>
          setDraft((current) =>
            current ? { ...current, [key]: event.target.value } : current,
          )
        }
        className={fieldClass}
      />
    </label>
  );

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {forms.map((form) => (
          <div
            key={form.id}
            className="flex items-center gap-2 rounded-xl border border-slate-600 bg-slate-900/70 py-2 pl-4 pr-2 text-sm font-semibold text-slate-100"
          >
            {form.name}
            <button
              type="button"
              aria-label={`Edit ${form.name}`}
              title="Edit"
              className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-700 hover:text-white"
              onClick={() =>
                setDraft({
                  id: form.id,
                  name: form.name,
                  templateId: form.templateId,
                  apiToken: "",
                })
              }
            >
              <Pencil className="size-4" />
            </button>
          </div>
        ))}
        {!draft && (
          <Button
            type="button"
            variant="outline"
            aria-label="Add web form"
            title="Add web form"
            onClick={() =>
              setDraft({ id: null, name: "", templateId: "", apiToken: "" })
            }
          >
            <Plus data-icon="inline-start" />
            Add
          </Button>
        )}
        {!forms.length && !draft && (
          <span className="text-sm text-slate-500">
            No web form yet. Add one to send client cases to OneTrust.
          </span>
        )}
      </div>

      {draft && (
        <div className="grid gap-4 rounded-xl border border-indigo-400/30 bg-slate-900/60 p-4">
          <div className="grid gap-4 md:grid-cols-3">
            {field("Name", "name")}
            {field("ID", "templateId")}
            {field("Token", "apiToken", {
              secret: true,
              placeholder: draft.id ? "•••••••• (unchanged)" : undefined,
            })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              disabled={busy || !canSave}
              onClick={() => void save()}
            >
              {busy ? (
                <Loader2 data-icon="inline-start" className="animate-spin" />
              ) : (
                <Save data-icon="inline-start" />
              )}
              Save
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDraft(null)}
            >
              <X data-icon="inline-start" />
              Cancel
            </Button>
            {draft.id && (
              <Button
                type="button"
                variant="outline"
                className="ml-auto border-red-400/40 text-red-200 hover:bg-red-500/15"
                disabled={busy}
                onClick={() => void remove()}
              >
                <Trash2 data-icon="inline-start" />
                Delete
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
