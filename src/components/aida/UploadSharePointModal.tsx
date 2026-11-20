"use client";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { formatBytes } from "@/lib/format";
import { count } from "./case-view";
import { useCases } from "./cases-context";
import type { RequestItem } from "./types";
import { Btn, Modal } from "./ui";

interface Preview {
  blocked: string | null;
  destination: string;
  files: number;
  bytes: number;
  alreadyUploaded: number;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-6 px-4 py-3 text-[13px]">
      <span className="text-aida-muted">{label}</span>
      <span className="text-right font-medium text-aida-text">{value}</span>
    </div>
  );
}

/** Sends a request's delivered files to SharePoint by hand; files already there are skipped. */
export function UploadSharePointModal({
  target,
  onClose,
}: {
  target: RequestItem | null;
  onClose: () => void;
}) {
  const { refresh } = useCases();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setPreview(null);
    fetch(`/api/requests/${target.id}/upload`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!cancelled && body) setPreview(body as Preview);
      })
      .catch(() => {
        // The shell already shows when the connection is lost.
      });
    return () => {
      cancelled = true;
    };
  }, [target]);

  const pending = preview ? preview.files - preview.alreadyUploaded : 0;

  const upload = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/requests/${target.id}/upload`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        queued?: number;
      };
      if (!response.ok) throw new Error(body.error || "Upload failed.");
      toast.success("Upload started", {
        description: body.queued
          ? `${count(body.queued)} files are being uploaded in the background.`
          : "Everything is already uploaded.",
      });
      void refresh();
      onClose();
    } catch (failure) {
      toast.error(
        failure instanceof Error ? failure.message : "Upload failed.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={!!target}
      onClose={onClose}
      title="Upload to SharePoint"
      width={560}
      footer={
        <>
          <Btn kind="ghost" onClick={onClose}>
            Cancel
          </Btn>
          <Btn
            kind="primary"
            disabled={busy || !preview || !!preview.blocked || pending === 0}
            onClick={() => void upload()}
          >
            {pending > 0 ? `Upload ${count(pending)} files` : "Upload"}
          </Btn>
        </>
      }
    >
      {!preview ? (
        <div className="h-[154px] animate-pulse rounded-xl bg-aida-surface-2" />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="divide-y divide-aida-line overflow-hidden rounded-xl border border-aida-input-line bg-aida-surface-2">
            <Row label="Destination" value={preview.destination} />
            <Row label="Files" value={count(preview.files)} />
            <Row label="Size" value={formatBytes(preview.bytes)} />
            <Row
              label="Already uploaded"
              value={count(preview.alreadyUploaded)}
            />
          </div>
          <p className="rounded-[10px] border border-aida-primary-line bg-[#0f1830] px-3.5 py-3 text-[13px] leading-5 text-aida-text-2">
            {preview.blocked ??
              "Upload runs in the background. Files already uploaded are skipped, so it is safe to run again."}
          </p>
        </div>
      )}
    </Modal>
  );
}
