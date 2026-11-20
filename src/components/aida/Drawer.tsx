"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { cn } from "@/lib/utils";

/** Side panel over the page. Closes with Escape or a click on the dark side. */
export function Drawer({
  open,
  onClose,
  width = 560,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-[#05080f]/75"
      />
      <aside
        style={{ width, maxWidth: "100vw" }}
        className="absolute inset-y-0 right-0 flex flex-col overflow-y-auto border-l border-aida-primary-line/40 bg-aida-sidebar"
      >
        {children}
      </aside>
    </div>
  );
}

export function DrawerHeader({
  title,
  subtitle,
  onClose,
  back,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  back?: { label: string; onClick: () => void };
  actions?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 px-6 pt-6">
      <div className="flex min-w-0 flex-col gap-1">
        {back ? (
          <button
            type="button"
            onClick={back.onClick}
            className="w-fit text-[13px] font-medium text-aida-primary-text hover:underline"
          >
            ‹ {back.label}
          </button>
        ) : null}
        <h2 className="text-xl font-bold leading-6 text-aida-text">{title}</h2>
        {subtitle ? (
          <p className="text-[13px] text-aida-muted">{subtitle}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-[10px] bg-aida-nav-active/60 text-aida-text-3 hover:text-white"
        >
          <X className="size-4" strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}

export function Pill({
  tone,
  children,
  className,
}: {
  tone: "green" | "red" | "amber" | "blue" | "grey";
  children: ReactNode;
  className?: string;
}) {
  const tones = {
    green: "bg-[#0f2a22] text-[#8de3c3]",
    red: "bg-[#2e1517] text-[#f5a3a0]",
    amber: "bg-[#2c2110] text-[#f1cd8f]",
    blue: "bg-aida-primary-soft text-[#c9d8ff]",
    grey: "bg-aida-nav-active text-aida-text-3",
  } as const;
  const dot = {
    green: "bg-aida-green-dot",
    red: "bg-aida-red",
    amber: "bg-aida-amber",
    blue: "bg-aida-primary",
    grey: "bg-aida-dim",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-semibold",
        tones[tone],
        className,
      )}
    >
      <span className={cn("size-1.5 rounded-full", dot[tone])} />
      {children}
    </span>
  );
}
