"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ONETRUST_FIELDS, parseRequiredFields } from "@/lib/onetrust-forms";
import { cn } from "@/lib/utils";
import { Btn, Modal } from "./ui";

interface FormRef {
  id: string;
  name: string;
  requiredFields: string[];
}

function Switch({
  on,
  disabled,
  label,
  onChange,
}: {
  on: boolean;
  disabled?: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cn(
        "flex h-[22px] w-10 shrink-0 items-center rounded-full p-[3px] transition-colors",
        on ? "justify-end bg-aida-primary" : "justify-start bg-[#2a3550]",
        disabled && "opacity-60",
      )}
    >
      <span className="size-4 rounded-full bg-white" />
    </button>
  );
}

/** Which case details a web form needs before a request can be sent. */
export function RequiredFieldsModal({
  form,
  onClose,
  onSaved,
}: {
  form: FormRef | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (form) setPicked(parseRequiredFields(form.requiredFields));
  }, [form]);

  const save = async () => {
    if (!form) return;
    setBusy(true);
    try {
      const current = await fetch("/api/onetrust-forms", {
        cache: "no-store",
      }).then((response) => response.json());
      const saved = (current.forms ?? []).find(
        (entry: { id: string }) => entry.id === form.id,
      );
      if (!saved) throw new Error("The web form no longer exists.");
      const response = await fetch(`/api/onetrust-forms/${form.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...saved,
          id: undefined,
          requiredFields: picked,
        }),
      });
      if (!response.ok) throw new Error("Could not save the fields.");
      toast.success("Required fields saved.");
      onSaved();
      onClose();
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : "Could not save the fields.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!form}
      onClose={onClose}
      title="Required fields"
      description={form?.name}
      width={600}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn kind="primary" disabled={busy} onClick={() => void save()}>
            Save fields
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-sm text-aida-text-2">
          Choose which case details OneTrust needs before a request can be sent.
        </p>
        {ONETRUST_FIELDS.map((field) => (
          <div
            key={field.key}
            className="flex items-center justify-between gap-3 rounded-[10px] border border-aida-input-line bg-aida-surface-2 px-3.5 py-2.5"
          >
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-aida-text">
                {field.label}
              </span>
              <span className="text-xs text-aida-muted">
                {field.source}
                {field.locked ? " · always required by OneTrust" : ""}
              </span>
            </div>
            <Switch
              on={picked.includes(field.key)}
              disabled={field.locked}
              label={`${field.label} required`}
              onChange={(next) =>
                setPicked((current) =>
                  next
                    ? [...current, field.key]
                    : current.filter((key) => key !== field.key),
                )
              }
            />
          </div>
        ))}
        <div className="flex items-center justify-between gap-3 rounded-[10px] border border-aida-input-line bg-aida-surface-2 px-3.5 py-2.5">
          <div className="flex flex-col gap-0.5">
            <span className="text-sm font-medium text-aida-text">
              Request type
            </span>
            <span className="text-xs text-aida-muted">
              Fixed · Access request
            </span>
          </div>
          <Switch
            on
            disabled
            label="Request type required"
            onChange={() => {}}
          />
        </div>
        <p className="rounded-[10px] border border-aida-primary-line bg-[#0f1830] px-3.5 py-3 text-[13px] leading-5 text-aida-text-2">
          A required field that is empty blocks “Send to OneTrust” and shows
          which field to fix.
        </p>
      </div>
    </Modal>
  );
}
