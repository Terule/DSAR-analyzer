"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/lib/format";
import type { FoundRequest } from "@/lib/input-scan";
import { cn } from "@/lib/utils";
import { count } from "./case-view";
import { useCases } from "./cases-context";
import type { CaseItem } from "./types";
import { Btn, Field, Modal } from "./ui";

type Folder = { name: string; inCase: boolean };

function content(request: FoundRequest): string {
  const parts = [
    request.pstCount
      ? `${count(request.pstCount)} PST${request.pstCount === 1 ? "" : "s"}`
      : null,
    request.fileCount
      ? `${count(request.fileCount)} file${request.fileCount === 1 ? "" : "s"}`
      : null,
  ].filter(Boolean);
  return parts.join(" · ") || "Nothing yet";
}

/**
 * Finds what was delivered in the input folder. From a case it adds the
 * requests that are not in the case yet; from the list it also creates the case.
 */
export function ScanInputModal({
  open,
  onClose,
  caseTarget,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  caseTarget?: CaseItem | null;
  onDone: (caseId: string) => void;
}) {
  const { refresh } = useCases();
  const [folders, setFolders] = useState<Folder[] | null>(null);
  const [folder, setFolder] = useState<string>("");
  const [type, setType] = useState<"employee" | "client">("employee");
  const [found, setFound] = useState<FoundRequest[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFound(null);
    setError(null);
    setFolder(caseTarget?.name ?? "");
    setType("employee");
    if (caseTarget) return;
    setFolders(null);
    fetch("/api/scan-input", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { folders?: Folder[] }) => setFolders(body.folders ?? []))
      .catch(() => setFolders([]));
  }, [open, caseTarget]);

  useEffect(() => {
    if (!open || !folder) return;
    let cancelled = false;
    setScanning(true);
    setFound(null);
    setError(null);
    fetch(`/api/scan-input?folder=${encodeURIComponent(folder)}`, {
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json()) as {
          requests?: FoundRequest[];
          error?: string;
        };
        if (!response.ok) throw new Error(body.error || "The scan failed.");
        if (!cancelled) setFound(body.requests ?? []);
      })
      .catch((failure) => {
        if (!cancelled)
          setError(
            failure instanceof Error ? failure.message : "The scan failed.",
          );
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, folder]);

  const addable = (found ?? []).filter(
    (request) => !request.existing && request.scope,
  );
  const already = (found ?? []).filter((request) => request.existing);
  const caseExists =
    !!caseTarget || !!folders?.find((entry) => entry.name === folder)?.inCase;
  const names = addable.map((request) => request.name).join(", ");

  const add = async () => {
    setAdding(true);
    try {
      const response = await fetch("/api/scan-input", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder, caseType: type }),
      });
      const body = (await response.json()) as {
        caseId?: string;
        added?: string[];
        error?: string;
      };
      if (!response.ok || !body.caseId)
        throw new Error(body.error || "Could not add the requests.");
      await refresh(true);
      toast.success(
        caseExists
          ? `Added ${body.added?.join(", ")}.`
          : `Case ${folder} created.`,
        {
          description: caseExists
            ? undefined
            : `${folder} is ready for its subject details.`,
        },
      );
      onDone(body.caseId);
      onClose();
    } catch (failure) {
      toast.error(
        failure instanceof Error
          ? failure.message
          : "Could not add the requests.",
      );
    } finally {
      setAdding(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Scan input folder"
      description={
        scanning
          ? "Find what was delivered and create the case from it."
          : "Choose what to add."
      }
      footer={
        <>
          <Btn kind="secondary" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={adding || scanning || addable.length === 0}
            onClick={() => void add()}
          >
            {adding ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {caseExists
              ? `Add ${names || "requests"}`
              : addable.length > 1
                ? `Create case with ${addable.length} requests`
                : "Create case"}
          </Btn>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {caseTarget ? (
          <Field label="Input folder">
            <div className="rounded-[10px] border border-aida-input-line bg-aida-bg px-3.5 py-[11px] text-sm text-aida-text">
              Staging / {caseTarget.name}
            </div>
          </Field>
        ) : (
          <Field label="Input folder" hint="Folders under Staging">
            {folders === null ? (
              <div className="flex items-center gap-2 text-[13px] text-aida-muted">
                <Loader2 className="size-3.5 animate-spin" /> Looking…
              </div>
            ) : folders.length === 0 ? (
              <p className="rounded-[10px] border border-dashed border-aida-input-line px-3.5 py-4 text-[13px] text-aida-muted">
                The input folder is empty. Put the delivery in Staging / case /
                request / PST or Files first.
              </p>
            ) : (
              <div className="flex max-h-44 flex-col overflow-y-auto rounded-[10px] border border-aida-input-line bg-aida-bg">
                {folders.map((entry) => (
                  <button
                    type="button"
                    key={entry.name}
                    onClick={() => setFolder(entry.name)}
                    aria-pressed={folder === entry.name}
                    className={cn(
                      "flex items-center justify-between border-b border-aida-line px-3.5 py-2.5 text-left text-sm last:border-b-0 hover:bg-aida-nav-active",
                      folder === entry.name
                        ? "bg-aida-nav-active text-aida-text"
                        : "text-aida-text-2",
                    )}
                  >
                    Staging / {entry.name}
                    {entry.inCase ? (
                      <span className="rounded-md bg-[#2c2110] px-2 py-0.5 text-[11px] font-medium text-[#f1cd8f]">
                        Already in a case
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            )}
          </Field>
        )}

        {scanning ? (
          <div className="flex flex-col gap-1.5 rounded-xl border border-aida-primary-line bg-[#0e1730] p-4">
            <span className="flex items-center gap-2 text-sm font-medium text-aida-text">
              <Loader2 className="size-3.5 animate-spin" /> Scanning…
            </span>
            <span className="text-[13px] text-aida-muted">
              This can take a minute for large folders.
            </span>
          </div>
        ) : null}
        {error ? <p className="text-[13px] text-aida-red">{error}</p> : null}

        {found && !scanning ? (
          found.length === 0 ? (
            <p className="rounded-[10px] border border-dashed border-aida-input-line px-3.5 py-4 text-[13px] text-aida-muted">
              No requests found in this folder. Each request is a folder with a
              PST or Files folder inside.
            </p>
          ) : (
            <>
              <div className="text-[13px] font-medium text-aida-text-2">
                Found in this folder
              </div>
              <div className="overflow-hidden rounded-xl border border-aida-input-line">
                <div className="grid grid-cols-[1fr_1.6fr_1fr] gap-3 px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-aida-dim">
                  <span>Request</span>
                  <span>Content</span>
                  <span>Size</span>
                </div>
                {found.map((request) => (
                  <div
                    key={request.name}
                    className="grid grid-cols-[1fr_1.6fr_1fr] items-center gap-3 border-t border-aida-line px-4 py-3 text-[13px] text-aida-text-2"
                  >
                    <span className="flex items-center gap-2">
                      {request.name}
                      {request.existing ? (
                        <span className="rounded-md bg-[#2c2110] px-2 py-0.5 text-[11px] font-medium text-[#f1cd8f]">
                          Already in a case
                        </span>
                      ) : null}
                    </span>
                    <span>{request.existing ? "—" : content(request)}</span>
                    <span>
                      {request.existing
                        ? "—"
                        : formatBytes(request.pstBytes + request.fileBytes)}
                    </span>
                  </div>
                ))}
              </div>
              {addable.length > 0 ? (
                <p className="rounded-xl border border-aida-primary-line bg-[#0e1730] px-4 py-3 text-[13px] text-aida-text-2">
                  {caseExists
                    ? already.length
                      ? `${folder} already has request ${already.map((request) => request.name).join(", ")}. Only ${names} will be added.`
                      : `${names} will be added to ${folder}.`
                    : `A case named ${folder} will be created with ${names}. You add the subject details next.`}
                </p>
              ) : (
                <p className="rounded-xl border border-aida-input-line bg-aida-surface-2 px-4 py-3 text-[13px] text-aida-muted">
                  Nothing new to add: every request in this folder is already in
                  a case, or holds no PSTs or files yet.
                </p>
              )}
            </>
          )
        ) : null}

        {!caseExists && folder && addable.length > 0 && !scanning ? (
          <Field label="Case type">
            <div className="flex gap-3">
              {(["employee", "client"] as const).map((value) => (
                <button
                  type="button"
                  key={value}
                  aria-pressed={type === value}
                  onClick={() => setType(value)}
                  className={cn(
                    "flex-1 rounded-xl border px-4 py-2.5 text-left text-sm font-semibold capitalize",
                    type === value
                      ? "border-aida-primary bg-[#111a33] text-aida-text"
                      : "border-aida-input-line text-aida-text-2 hover:bg-aida-nav-active/40",
                  )}
                >
                  {value}
                </button>
              ))}
            </div>
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
