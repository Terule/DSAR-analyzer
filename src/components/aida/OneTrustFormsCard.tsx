"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Btn, Card, Field, Modal, TextInput } from "./ui";

interface FormSummary {
  id: string;
  name: string;
  templateId: string;
  dateRaisedFieldKey: string;
  systemLabel: string;
  language: string;
  subjectType: string;
}
interface Draft extends Omit<FormSummary, "id"> {
  id: string | null;
  apiToken: string;
}

const EMPTY: Draft = {
  id: null,
  name: "",
  templateId: "",
  apiToken: "",
  dateRaisedFieldKey: "formField81",
  systemLabel: "AIDA",
  language: "en-gb",
  subjectType: "Customer",
};

/** Saved OneTrust web forms. Each is saved on its own; the token is never sent back. */
export function OneTrustFormsCard() {
  const [forms, setForms] = useState<FormSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<FormSummary | null>(null);
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

  const canSave =
    !!draft?.name.trim() &&
    !!draft.templateId.trim() &&
    (!!draft.id || !!draft.apiToken.trim());

  const save = async () => {
    if (!draft || !canSave) return;
    setBusy(true);
    try {
      const response = await fetch(
        draft.id ? `/api/onetrust-forms/${draft.id}` : "/api/onetrust-forms",
        {
          method: draft.id ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...draft, id: undefined }),
        },
      );
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error || "Could not save the form.");
      setDraft(null);
      await load();
      toast.success("Web form saved.");
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Could not save the form.",
      );
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await fetch(`/api/onetrust-forms/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      await load();
      toast.success("Web form deleted.");
    } finally {
      setBusy(false);
    }
  };

  const field = (
    label: string,
    key: keyof Draft,
    props: { secret?: boolean; hint?: string; placeholder?: string } = {},
  ) => (
    <Field label={label} hint={props.hint}>
      <TextInput
        type={props.secret ? "password" : "text"}
        autoComplete={props.secret ? "new-password" : "off"}
        data-lpignore="true"
        placeholder={props.placeholder}
        value={String(draft?.[key] ?? "")}
        onChange={(event) =>
          setDraft((current) =>
            current ? { ...current, [key]: event.target.value } : current,
          )
        }
      />
    </Field>
  );

  return (
    <Card className="flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-6">
        <div className="flex flex-col gap-1">
          <h2 className="text-[17px] font-semibold text-aida-text">
            Web forms
          </h2>
          <p className="text-[13px] text-aida-muted">
            Each form defines which fields a request needs.
          </p>
        </div>
        <Btn kind="soft" onClick={() => setDraft({ ...EMPTY })}>
          Add web form
        </Btn>
      </div>
      {forms.length === 0 ? (
        <p className="rounded-xl border border-dashed border-aida-input-line px-4 py-6 text-center text-[13px] text-aida-muted">
          No web form yet. Add one to send client cases to OneTrust.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-aida-line">
          <div className="grid grid-cols-[1.4fr_1fr_0.7fr_120px] gap-4 bg-aida-surface-2 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-aida-dim">
            <span>Form</span>
            <span>Label</span>
            <span>Language</span>
            <span />
          </div>
          {forms.map((form) => (
            <div
              key={form.id}
              className="grid grid-cols-[1.4fr_1fr_0.7fr_120px] items-center gap-4 border-t border-aida-line px-4 py-3 text-sm"
            >
              <span className="truncate font-medium text-aida-text">
                {form.name}
              </span>
              <span className="text-aida-muted">{form.systemLabel}</span>
              <span className="text-aida-muted">{form.language}</span>
              <span className="flex justify-end gap-3 text-[13px]">
                <button
                  type="button"
                  className="text-aida-primary-text hover:underline"
                  onClick={() => setDraft({ ...form, apiToken: "" })}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="text-aida-red hover:underline"
                  onClick={() => setRemoving(form)}
                >
                  Delete
                </button>
              </span>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={!!draft}
        onClose={() => setDraft(null)}
        title={draft?.id ? "Edit web form" : "Add web form"}
        description="The form is saved on its own; the token is never shown again."
        footer={
          <>
            <Btn kind="ghost" onClick={() => setDraft(null)}>
              Cancel
            </Btn>
            <Btn
              kind="primary"
              disabled={!canSave || busy}
              onClick={() => void save()}
            >
              Save form
            </Btn>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {field("Name", "name")}
          <div className="grid grid-cols-2 gap-3">
            {field("OneTrust web form ID", "templateId")}
            {field("Token", "apiToken", {
              secret: true,
              placeholder: draft?.id ? "•••••••• (unchanged)" : undefined,
            })}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {field("Date Raised field key", "dateRaisedFieldKey", {
              hint: "receives today’s date",
            })}
            {field("Results Summary label", "systemLabel", {
              hint: "source name for uploaded files",
            })}
            {field("Language", "language")}
            {field("Client user type", "subjectType")}
          </div>
        </div>
      </Modal>
      <Modal
        open={!!removing}
        onClose={() => setRemoving(null)}
        tone="danger"
        title="Delete web form?"
        description={`${removing?.name ?? ""} will be removed. Cases already sent to OneTrust are not affected.`}
        footer={
          <>
            <Btn kind="ghost" onClick={() => setRemoving(null)}>
              Cancel
            </Btn>
            <Btn kind="danger" disabled={busy} onClick={() => void remove()}>
              Delete form
            </Btn>
          </>
        }
      />
    </Card>
  );
}
