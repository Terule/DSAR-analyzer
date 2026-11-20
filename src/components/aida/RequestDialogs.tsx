"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useCases } from "./cases-context";
import type { CaseItem, RequestItem, Scope } from "./types";
import { Btn, Field, Modal, TextInput } from "./ui";

const SCOPES: Array<{ value: Scope; label: string; text: string }> = [
  { value: "mail", label: "Emails", text: "PST files only" },
  { value: "files", label: "Files", text: "Loose files and Teams chats" },
  { value: "both", label: "Emails and files", text: "The complete delivery" },
];

function ScopePicker({
  value,
  onChange,
  allowed,
}: {
  value: Scope;
  onChange: (value: Scope) => void;
  allowed?: Scope[];
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {SCOPES.filter((scope) => !allowed || allowed.includes(scope.value)).map(
        (scope) => (
          <button
            type="button"
            key={scope.value}
            aria-pressed={value === scope.value}
            onClick={() => onChange(scope.value)}
            className={cn(
              "flex flex-col gap-1 rounded-xl border p-3.5 text-left",
              value === scope.value
                ? "border-aida-primary bg-[#111a33]"
                : "border-aida-input-line hover:bg-aida-nav-active/40",
            )}
          >
            <span className="text-sm font-semibold text-aida-text">
              {scope.label}
            </span>
            <span className="text-xs text-aida-muted">{scope.text}</span>
          </button>
        ),
      )}
    </div>
  );
}

export function NewRequestModal({
  target,
  onClose,
  onCreated,
}: {
  target: CaseItem | null;
  onClose: () => void;
  onCreated?: (name: string) => void;
}) {
  const { call, busy } = useCases();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("both");
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!target) return;
    setName(`R${target.requests.length + 1}`);
    setScope("both");
    setTried(false);
  }, [target]);
  const trimmed = name.trim();
  const error = !trimmed
    ? "Enter a request name."
    : target?.requests.some(
          (request) => request.name.toLowerCase() === trimmed.toLowerCase(),
        )
      ? "This case already has a request with this name."
      : null;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="New request"
      description="A request is one delivery of PSTs or files."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!!target && busy === `add-${target.id}`}
            onClick={async () => {
              setTried(true);
              if (!target || error) return;
              const result = await call(
                `add-${target.id}`,
                `/api/cases/${target.id}/requests`,
                {
                  method: "POST",
                  body: JSON.stringify({ name: trimmed, scope }),
                },
              );
              if (result) {
                toast.success(`Request ${trimmed} created.`);
                onCreated?.(trimmed);
                onClose();
              }
            }}
          >
            Create request
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Request name" error={tried ? error : null}>
          <TextInput
            autoFocus
            value={name}
            invalid={tried && !!error}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label="What it holds">
          <ScopePicker value={scope} onChange={setScope} />
        </Field>
      </div>
    </Modal>
  );
}

export function ContinueWaveModal({
  target,
  onClose,
}: {
  target: RequestItem | null;
  onClose: () => void;
}) {
  const { call, busy } = useCases();
  const [add, setAdd] = useState<Scope>("mail");
  useEffect(() => {
    if (target) setAdd(target.scope === "files" ? "files" : "mail");
  }, [target]);
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="Continue with a new wave"
      description="Start a new wave of the same request, for example when more files were added to the input folder. Everything already delivered is kept; only new items are processed."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!!target && busy === `continue-${target.id}`}
            onClick={async () => {
              if (!target) return;
              const result = await call(
                `continue-${target.id}`,
                `/api/requests/${target.id}/continue`,
                {
                  method: "POST",
                  body: JSON.stringify({ add }),
                },
              );
              if (result) {
                toast.success(`New wave started for ${target.name}.`);
                onClose();
              }
            }}
          >
            Start wave
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Request">
          <div className="rounded-[10px] border border-aida-input-line bg-aida-bg px-3.5 py-[11px] text-sm text-aida-text">
            {target?.name}
          </div>
        </Field>
        <Field label="What to process">
          <ScopePicker value={add} onChange={setAdd} />
        </Field>
        <p className="text-xs text-aida-dim">
          Items already seen in this request are recognised and skipped as
          duplicates.
        </p>
      </div>
    </Modal>
  );
}

export function ResetRequestModal({
  target,
  onClose,
}: {
  target: RequestItem | null;
  onClose: () => void;
}) {
  const { call, busy } = useCases();
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      tone="danger"
      title={`Reset ${target?.name ?? ""}?`}
      description={`Removes everything produced for this request${
        target && target.wave > 1 ? ` in all ${target.wave} waves` : ""
      } and starts again from the beginning. The delivered PDFs and the audit trail are deleted. The source PSTs must still be in the input folder.`}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="danger"
            disabled={!!target && busy === `reset-${target.id}`}
            onClick={async () => {
              if (!target) return;
              if (
                await call(
                  `reset-${target.id}`,
                  `/api/requests/${target.id}/reset`,
                  { method: "POST" },
                )
              ) {
                toast.success(`${target.name} was reset.`);
                onClose();
              }
            }}
          >
            Reset request
          </Btn>
        </>
      }
    >
      <p className="rounded-xl border border-aida-amber/30 bg-aida-amber/10 p-3.5 text-[13px] leading-5 text-[#f1cd8f]">
        If the source PSTs were deleted after delivery, this request cannot be
        processed again.
      </p>
    </Modal>
  );
}

export function DeleteRequestModal({
  target,
  onClose,
  onDeleted,
}: {
  target: RequestItem | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { call, busy } = useCases();
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      tone="danger"
      title={`Delete request ${target?.name ?? ""}?`}
      description="This cannot be undone. The request and its output will be removed. Other requests are not affected."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="danger"
            disabled={!!target && busy === `delete-${target.id}`}
            onClick={async () => {
              if (!target) return;
              if (
                await call(
                  `delete-${target.id}`,
                  `/api/requests/${target.id}`,
                  { method: "DELETE" },
                )
              ) {
                toast.success(`Request ${target.name} deleted.`);
                onClose();
                onDeleted();
              }
            }}
          >
            Delete request
          </Btn>
        </>
      }
    />
  );
}

export function StopWorkModal({
  target,
  onClose,
}: {
  target: CaseItem | null;
  onClose: () => void;
}) {
  const { call, busy } = useCases();
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      tone="danger"
      title={`Stop all work on ${target?.name ?? ""}?`}
      description="Cancels every job and AI batch of this case. Work already finished is kept, and the case can be started again later."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Keep running
          </Btn>
          <Btn
            kind="danger"
            disabled={!!target && busy === `stop-${target.id}`}
            onClick={async () => {
              if (!target) return;
              const result = await call(
                `stop-${target.id}`,
                `/api/cases/${target.id}`,
                { method: "POST" },
              );
              if (result?.stopped) {
                toast.success("All work has stopped.");
                onClose();
              } else if (result) {
                toast.info(
                  "Stopping background workers. Select Stop all work again to check progress.",
                );
              }
            }}
          >
            Stop all work
          </Btn>
        </>
      }
    />
  );
}
