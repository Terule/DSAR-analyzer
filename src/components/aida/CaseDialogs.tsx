"use client";

import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isConfigured } from "./case-view";
import { useCases } from "./cases-context";
import type { CaseItem } from "./types";
import { Btn, Field, Modal, TextInput } from "./ui";

const RUNNING = ["queued", "running", "stopping"];

/* ---------- New case (two steps: the case, then the subject) ---------- */

const EMPTY_SUBJECT = {
  subjectName: "",
  subjectEmail: "",
  personalEmail: "",
  aliases: [] as string[],
  matterNumbers: "",
};

function Steps({ step }: { step: 1 | 2 }) {
  const dot = (n: number, label: string) => {
    const done = step > n;
    const current = step === n;
    return (
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-[22px] items-center justify-center rounded-full text-xs font-semibold",
            done
              ? "bg-aida-green text-white"
              : current
                ? "bg-aida-primary text-white"
                : "bg-aida-nav-active text-aida-muted",
          )}
        >
          {done ? <Check className="size-3" strokeWidth={3} /> : n}
        </span>
        <span
          className={cn(
            "text-[13px]",
            current ? "font-semibold text-aida-text" : "text-aida-muted",
          )}
        >
          {label}
        </span>
      </div>
    );
  };
  return (
    <div className="flex items-center gap-3">
      {dot(1, "Case")}
      <span className="h-px w-12 bg-aida-input-line" />
      {dot(2, "Subject")}
    </div>
  );
}

function TypeCard({
  active,
  title,
  text,
  onClick,
}: {
  active: boolean;
  title: string;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-1 flex-col gap-1.5 rounded-xl border p-4 text-left",
        active
          ? "border-aida-primary bg-[#111a33]"
          : "border-aida-input-line hover:bg-aida-nav-active/40",
      )}
    >
      <span className="text-sm font-semibold text-aida-text">{title}</span>
      <span className="text-[13px] leading-[15px] text-aida-muted">{text}</span>
    </button>
  );
}

function AliasInput({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const commit = () => {
    const name = draft.trim();
    if (name && !value.includes(name)) onChange([...value, name]);
    setDraft("");
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[10px] border border-aida-input-line bg-aida-bg px-3 py-2 focus-within:border-aida-primary">
      {value.map((alias) => (
        <button
          type="button"
          key={alias}
          title="Remove"
          onClick={() => onChange(value.filter((item) => item !== alias))}
          className="rounded-full bg-aida-primary-soft px-2.5 py-1 text-[13px] text-[#c9d8ff] hover:brightness-125"
        >
          {alias}
        </button>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === ",") {
            event.preventDefault();
            commit();
          } else if (event.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
          }
        }}
        placeholder={value.length ? "" : "Type and press Enter"}
        className="min-w-[120px] flex-1 bg-transparent py-1 text-[13px] text-aida-text outline-none placeholder:text-aida-dim"
      />
    </div>
  );
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function NewCaseModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (created: { id: string }) => void;
}) {
  const { call, busy, cases } = useCases();
  const [step, setStep] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [type, setType] = useState<"employee" | "client">("employee");
  const [subject, setSubject] = useState(EMPTY_SUBJECT);
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep(1);
    setName("");
    setType("employee");
    setSubject(EMPTY_SUBJECT);
    setTried(false);
  }, [open]);

  const trimmed = name.trim();
  const nameError = !trimmed
    ? "Enter the case name."
    : cases.some((item) => item.name.toLowerCase() === trimmed.toLowerCase())
      ? "A case with this name already exists."
      : null;
  const subjectErrors = {
    name: subject.subjectName.trim() ? null : "Enter the full name.",
    email: EMAIL.test(subject.subjectEmail.trim())
      ? null
      : "Enter a valid work email.",
    personal:
      !subject.personalEmail.trim() || EMAIL.test(subject.personalEmail.trim())
        ? null
        : "Enter a valid email or leave it empty.",
  };

  const create = async () => {
    setTried(true);
    if (Object.values(subjectErrors).some(Boolean)) return;
    const made = await call("create", "/api/cases", {
      method: "POST",
      body: JSON.stringify({ name: trimmed, caseType: type }),
    });
    const created = made?.case as { id: string } | undefined;
    if (!created) return;
    const configured = await call(
      `configure-${created.id}`,
      `/api/cases/${created.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          subjectName: subject.subjectName.trim(),
          subjectEmail: subject.subjectEmail.trim(),
          personalEmail: subject.personalEmail.trim(),
          aliases: subject.aliases,
          matterNumbers: subject.matterNumbers.trim(),
        }),
      },
    );
    if (configured) {
      toast.success(`Case ${trimmed} created.`);
      onCreated(created);
      onClose();
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New case"
      description={
        step === 1
          ? "A case gathers the requests of one data subject."
          : "Who is the data subject? These details define what the system looks for."
      }
      footer={
        step === 1 ? (
          <>
            <Btn kind="ghost" onClick={onClose}>
              Cancel
            </Btn>
            <Btn
              kind="primary"
              onClick={() => {
                setTried(true);
                if (!nameError) {
                  setTried(false);
                  setStep(2);
                }
              }}
            >
              Continue
            </Btn>
          </>
        ) : (
          <>
            <Btn kind="ghost" onClick={() => setStep(1)}>
              Back
            </Btn>
            <Btn
              kind="primary"
              disabled={busy === "create"}
              onClick={() => void create()}
            >
              Create case
            </Btn>
          </>
        )
      }
    >
      <div className="flex flex-col gap-5">
        <Steps step={step} />
        {step === 1 ? (
          <>
            <Field label="Case name" error={tried ? nameError : null}>
              <TextInput
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !nameError) setStep(2);
                }}
                invalid={tried && !!nameError}
                placeholder="ACM Corp"
              />
            </Field>
            <Field label="Case type">
              <div className="flex gap-3">
                <TypeCard
                  active={type === "employee"}
                  title="Employee"
                  text="The AI reviews emails and protects what is confidential. Doubtful items go to HR review."
                  onClick={() => setType("employee")}
                />
                <TypeCard
                  active={type === "client"}
                  title="Client"
                  text="Keeps everything that is unique. Only the confidentiality screening decides what does not go on."
                  onClick={() => setType("client")}
                />
              </div>
            </Field>
          </>
        ) : (
          <>
            <Field label="Full name" error={tried ? subjectErrors.name : null}>
              <TextInput
                autoFocus
                value={subject.subjectName}
                invalid={tried && !!subjectErrors.name}
                onChange={(event) =>
                  setSubject({ ...subject, subjectName: event.target.value })
                }
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Work email"
                error={tried ? subjectErrors.email : null}
              >
                <TextInput
                  value={subject.subjectEmail}
                  invalid={tried && !!subjectErrors.email}
                  onChange={(event) =>
                    setSubject({ ...subject, subjectEmail: event.target.value })
                  }
                />
              </Field>
              <Field
                label="Personal email"
                error={tried ? subjectErrors.personal : null}
              >
                <TextInput
                  value={subject.personalEmail}
                  invalid={tried && !!subjectErrors.personal}
                  onChange={(event) =>
                    setSubject({
                      ...subject,
                      personalEmail: event.target.value,
                    })
                  }
                />
              </Field>
            </div>
            <Field label="Nicknames and other names">
              <AliasInput
                value={subject.aliases}
                onChange={(aliases) => setSubject({ ...subject, aliases })}
              />
            </Field>
            <Field label="Matter numbers" hint="sent to OneTrust only">
              <TextInput
                value={subject.matterNumbers}
                placeholder="M-20418, M-20419"
                onChange={(event) =>
                  setSubject({ ...subject, matterNumbers: event.target.value })
                }
              />
            </Field>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ---------- Configure (edit the subject of an existing case) ---------- */

export function ConfigureCaseModal({
  target,
  onClose,
}: {
  target: CaseItem | null;
  onClose: () => void;
}) {
  const { call, busy } = useCases();
  const [subject, setSubject] = useState(EMPTY_SUBJECT);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (!target) return;
    setTried(false);
    setSubject({
      subjectName: target.subject_name ?? "",
      subjectEmail: target.subject_email ?? "",
      personalEmail:
        (target as CaseItem & { subject_personal_email?: string | null })
          .subject_personal_email ?? "",
      aliases: (
        (target as CaseItem & { subject_aliases?: string | null })
          .subject_aliases ?? ""
      )
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      matterNumbers:
        (target as CaseItem & { matter_numbers?: string | null })
          .matter_numbers ?? "",
    });
  }, [target]);
  const errors = {
    name: subject.subjectName.trim() ? null : "Enter the full name.",
    email: EMAIL.test(subject.subjectEmail.trim())
      ? null
      : "Enter a valid work email.",
    personal:
      !subject.personalEmail.trim() || EMAIL.test(subject.personalEmail.trim())
        ? null
        : "Enter a valid email or leave it empty.",
  };
  const save = async () => {
    setTried(true);
    if (!target || Object.values(errors).some(Boolean)) return;
    const result = await call(
      `configure-${target.id}`,
      `/api/cases/${target.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          subjectName: subject.subjectName.trim(),
          subjectEmail: subject.subjectEmail.trim(),
          personalEmail: subject.personalEmail.trim(),
          aliases: subject.aliases,
          matterNumbers: subject.matterNumbers.trim(),
        }),
      },
    );
    if (result) onClose();
  };
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title={
        target && !isConfigured(target) ? "Configure case" : "Edit subject"
      }
      description="These details define what the system looks for."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!!target && busy === `configure-${target.id}`}
            onClick={() => void save()}
          >
            Save
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <Field label="Full name" error={tried ? errors.name : null}>
          <TextInput
            value={subject.subjectName}
            invalid={tried && !!errors.name}
            onChange={(event) =>
              setSubject({ ...subject, subjectName: event.target.value })
            }
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Work email" error={tried ? errors.email : null}>
            <TextInput
              value={subject.subjectEmail}
              invalid={tried && !!errors.email}
              onChange={(event) =>
                setSubject({ ...subject, subjectEmail: event.target.value })
              }
            />
          </Field>
          <Field label="Personal email" error={tried ? errors.personal : null}>
            <TextInput
              value={subject.personalEmail}
              invalid={tried && !!errors.personal}
              onChange={(event) =>
                setSubject({ ...subject, personalEmail: event.target.value })
              }
            />
          </Field>
        </div>
        <Field label="Nicknames and other names">
          <AliasInput
            value={subject.aliases}
            onChange={(aliases) => setSubject({ ...subject, aliases })}
          />
        </Field>
        <Field label="Matter numbers" hint="sent to OneTrust only">
          <TextInput
            value={subject.matterNumbers}
            onChange={(event) =>
              setSubject({ ...subject, matterNumbers: event.target.value })
            }
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- Archive and delete ---------- */

export function ArchiveCaseModal({
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
      title={`Archive ${target?.name ?? ""}?`}
      description="The case moves to History with its statistics. This permanently deletes every staging and deliverables folder of this completed case."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={!!target && busy === `archive-${target.id}`}
            onClick={async () => {
              if (
                target &&
                (await call(
                  `archive-${target.id}`,
                  `/api/cases/${target.id}/archive`,
                  {
                    method: "POST",
                  },
                ))
              ) {
                toast.success(`${target.name} archived.`);
                onClose();
              }
            }}
          >
            Archive
          </Btn>
        </>
      }
    />
  );
}

export function DeleteCaseModal({
  target,
  onClose,
}: {
  target: CaseItem | null;
  onClose: () => void;
}) {
  const { call, busy, cases } = useCases();
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (target) setConfirmation("");
  }, [target]);
  // Read the live case so "Stop all work" is reflected once work really stops.
  const live = target
    ? (cases.find((item) => item.id === target.id) ?? target)
    : null;
  const working = live
    ? live.requests.filter((request) => RUNNING.includes(request.status))
    : [];
  const stopping = !!live && busy === `stop-${live.id}`;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      tone="danger"
      title={
        working.length
          ? `Stop all work and delete ${target?.name ?? ""}?`
          : `Delete ${target?.name ?? ""}?`
      }
      description={working.length ? undefined : "This cannot be undone."}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          {working.length && live ? (
            <Btn
              kind="danger"
              disabled={stopping}
              onClick={async () => {
                const result = await call(
                  `stop-${live.id}`,
                  `/api/cases/${live.id}`,
                  {
                    method: "POST",
                  },
                );
                if (result && !result.stopped) {
                  toast.info(
                    "Stopping background workers. Select Stop all work again to check progress.",
                  );
                }
              }}
            >
              Stop all work
            </Btn>
          ) : null}
          <Btn
            kind="danger"
            disabled={
              !live ||
              confirmation !== live.name ||
              working.length > 0 ||
              busy === `delete-${live.id}`
            }
            onClick={async () => {
              if (
                live &&
                (await call(`delete-${live.id}`, `/api/cases/${live.id}`, {
                  method: "DELETE",
                  body: JSON.stringify({ confirmation }),
                }))
              ) {
                toast.success(`${live.name} deleted.`);
                onClose();
              }
            }}
          >
            Delete case
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {working.length ? (
          <div className="rounded-xl border border-aida-amber/30 bg-aida-amber/10 p-3.5 text-[13px] leading-5 text-[#f1cd8f]">
            {live?.name} is still working. Deleting stops all work first, which
            can take a minute.
          </div>
        ) : (
          <p className="text-sm leading-5 text-aida-text-3">
            This removes the case, its requests, all its staging and
            deliverables folders and every related database entry.
          </p>
        )}
        <Field label="Type the case name to confirm">
          <TextInput
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={live?.name}
          />
        </Field>
      </div>
    </Modal>
  );
}

/* ---------- Wipe the data of a case, keeping the case ---------- */

export function WipeCaseModal({
  target,
  onClose,
}: {
  target: CaseItem | null;
  onClose: () => void;
}) {
  const { call, busy } = useCases();
  const [confirmation, setConfirmation] = useState("");
  useEffect(() => {
    if (target) setConfirmation("");
  }, [target]);
  const wiping = !!target && busy === `wipe-${target.id}`;
  return (
    <Modal
      open={!!target}
      onClose={onClose}
      tone="danger"
      title={`Wipe data ${target?.name ?? ""}?`}
      description="Deletes the output of every request in this case, but keeps the case, its subject and its settings. The audit trail of each request is deleted too. Source PSTs stay in the input folder."
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="danger"
            disabled={!target || confirmation !== target.name || wiping}
            onClick={async () => {
              if (!target) return;
              const result = await call(
                `wipe-${target.id}`,
                `/api/cases/${target.id}/wipe`,
                {
                  method: "POST",
                  body: JSON.stringify({ confirmation }),
                },
              );
              if (result) {
                toast.success(`Data of ${target.name} wiped.`, {
                  description: `${String(result.wiped)} ${result.wiped === 1 ? "request" : "requests"} are ready to run again.`,
                });
                onClose();
              }
            }}
          >
            Wipe data
          </Btn>
        </>
      }
    >
      <Field label="Type the case name to confirm">
        <TextInput
          value={confirmation}
          placeholder={target?.name}
          onChange={(event) => setConfirmation(event.target.value)}
        />
      </Field>
    </Modal>
  );
}
