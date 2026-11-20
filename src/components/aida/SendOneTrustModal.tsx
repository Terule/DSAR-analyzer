"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  fieldProblem,
  ONETRUST_FIELDS,
  parseRequiredFields,
} from "@/lib/onetrust-forms";
import { cn } from "@/lib/utils";
import { useCases } from "./cases-context";
import type { CaseItem } from "./types";
import { Btn, Modal } from "./ui";

interface Form {
  id: string;
  name: string;
  requiredFields: string[];
}

const STATUS: Record<string, string> = {
  idle: "Not sent",
  creating: "Creating the request…",
  uploading: "Uploading files…",
  awaiting_request: "Waiting for OneTrust to confirm the request",
  created: "Request created",
  completed: "Sent",
  partial: "Sent, some files did not upload",
  failed: "Failed",
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3 text-[13px]">
      <span className="text-aida-muted">{label}</span>
      <span className="text-right font-medium text-aida-text">{children}</span>
    </div>
  );
}

/** What the system sends to OneTrust, checked before it is sent. */
export function SendOneTrustModal({
  target,
  onClose,
  onFix,
}: {
  target: CaseItem | null;
  onClose: () => void;
  onFix: (item: CaseItem) => void;
}) {
  const { call, busy } = useCases();
  const [forms, setForms] = useState<Form[]>([]);
  const [formId, setFormId] = useState("");
  useEffect(() => {
    if (!target) return;
    setFormId("");
    fetch("/api/onetrust-forms", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { forms?: Form[] }) => {
        const list = body.forms ?? [];
        setForms(list);
        if (list.length === 1) setFormId(list[0].id);
      })
      .catch(() => setForms([]));
  }, [target]);

  const chosen = forms.find((form) => form.id === formId) ?? forms[0];
  const required = useMemo(
    () => parseRequiredFields(chosen?.requiredFields),
    [chosen],
  );
  const fields = useMemo(() => {
    const subject = {
      name: target?.subject_name ?? "",
      email: target?.subject_email ?? "",
      personalEmail: target?.subject_personal_email ?? null,
      matterNumbers: target?.matter_numbers ?? null,
    };
    const values: Record<string, string> = {
      subject_name: subject.name.trim().split(/\s+/).filter(Boolean).join(" "),
      work_email: subject.email,
      personal_email: subject.personalEmail ?? "",
      matter_number: subject.matterNumbers ?? "",
    };
    return ONETRUST_FIELDS.map((field) => {
      const isRequired = required.includes(field.key);
      return {
        label: field.label,
        value: values[field.key],
        problem: isRequired ? fieldProblem(field.key, subject) : null,
        required: isRequired,
      };
    });
  }, [target, required]);
  const blocked = fields.some((field) => field.required && field.problem);
  const needsForm = forms.length > 1 && !target?.onetrust_request_id && !formId;
  const sent =
    target?.onetrust_status === "completed" ||
    target?.onetrust_status === "partial";
  const busyNow = !!target && busy === `onetrust-${target.id}`;

  const send = async () => {
    if (!target) return;
    const result = await call(
      `onetrust-${target.id}`,
      `/api/cases/${target.id}/onetrust`,
      {
        method: "POST",
        body: JSON.stringify({ formId: formId || undefined }),
      },
    );
    if (!result) return;
    const parts = [
      result.uploaded ? `${result.uploaded} uploaded` : null,
      result.skipped ? `${result.skipped} oversized` : null,
      result.failed ? `${result.failed} failed` : null,
    ].filter(Boolean);
    const detail = parts.join(", ") || "no files to upload";
    if (result.status === "completed")
      toast.success("Sent to OneTrust", { description: detail });
    else
      toast.warning(`OneTrust ${String(result.status)}`, {
        description: detail,
      });
    onClose();
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="Send to OneTrust"
      description="Creates the data subject request in OneTrust and uploads the delivered files."
      footer={
        <>
          <Btn kind="secondary" onClick={onClose}>
            Cancel
          </Btn>
          {blocked && target ? (
            <Btn
              kind="soft"
              onClick={() => {
                onClose();
                onFix(target);
              }}
            >
              Fix missing field
            </Btn>
          ) : null}
          <Btn
            kind="primary"
            disabled={blocked || needsForm || busyNow}
            onClick={() => void send()}
          >
            {busyNow ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {sent ? "Sync" : "Send"}
          </Btn>
        </>
      }
    >
      {target ? (
        <div className="flex flex-col gap-5">
          <div className="divide-y divide-aida-line overflow-hidden rounded-xl border border-aida-input-line">
            <Row label="Form">
              {target.onetrust_request_id || forms.length <= 1 ? (
                (forms[0]?.name ?? "—")
              ) : (
                <select
                  value={formId}
                  onChange={(event) => setFormId(event.target.value)}
                  aria-label="OneTrust web form"
                  className="rounded-md border border-aida-input-line bg-aida-bg px-2 py-1 text-[13px] text-aida-text outline-none focus:border-aida-primary"
                >
                  <option value="">Choose a web form…</option>
                  {forms.map((form) => (
                    <option key={form.id} value={form.id}>
                      {form.name}
                    </option>
                  ))}
                </select>
              )}
            </Row>
            <Row label="Matter numbers">{target.matter_numbers || "—"}</Row>
            <Row label="Status">
              <span
                className={cn(
                  target.onetrust_status === "failed" && "text-aida-red",
                )}
              >
                {STATUS[target.onetrust_status] ?? target.onetrust_status}
              </span>
            </Row>
            {target.onetrust_request_id ? (
              <>
                <Row label="Request">
                  {target.onetrust_request_id ? (
                    target.onetrust_url ? (
                      <a
                        href={target.onetrust_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-aida-primary-text hover:underline"
                      >
                        {target.onetrust_request_id}
                      </a>
                    ) : (
                      target.onetrust_request_id
                    )
                  ) : (
                    "—"
                  )}
                </Row>
                <Row label="Files uploaded">
                  {target.onetrust_total > 0
                    ? `${target.onetrust_uploaded} of ${target.onetrust_total}`
                    : "—"}
                </Row>
              </>
            ) : null}
            <Row label="Last sync">
              {sent && target.updated_at
                ? new Date(target.updated_at).toLocaleString("en-GB", {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "—"}
            </Row>
          </div>
          {target.onetrust_error ? (
            <p className="rounded-xl border border-[#7d3033] bg-[#241012] px-4 py-3 text-[13px] text-[#f5a3a0]">
              {target.onetrust_error}
            </p>
          ) : null}
          <div className="text-[13px] font-medium text-aida-text-2">
            Required fields
          </div>
          <div className="overflow-hidden rounded-xl border border-aida-input-line">
            <div className="grid grid-cols-[1fr_1.4fr] gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-aida-dim">
              <span>Field</span>
              <span>Value</span>
            </div>
            {fields.map((field) => (
              <div
                key={field.label}
                className="grid grid-cols-[1fr_1.4fr] items-center gap-3 border-t border-aida-line px-4 py-3 text-[13px] text-aida-text-2"
              >
                <span>{field.label}</span>
                {field.problem ? (
                  <span className="w-fit rounded-md bg-[#2e1517] px-2 py-0.5 text-[11px] font-medium text-[#f5a3a0]">
                    {field.problem}
                  </span>
                ) : field.value ? (
                  <span className="truncate">{field.value}</span>
                ) : (
                  <span className="text-aida-dim">Optional · not set</span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
