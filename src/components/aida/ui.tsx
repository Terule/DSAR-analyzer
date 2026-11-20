"use client";

import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { Search, X } from "lucide-react";
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
} from "react";
import { cn } from "@/lib/utils";

/* ---------- Buttons ---------- */

type ButtonKind = "primary" | "secondary" | "soft" | "danger" | "ghost";

const BUTTON_KIND: Record<ButtonKind, string> = {
  primary: "bg-aida-primary text-white hover:brightness-110",
  secondary:
    "border border-aida-input-line bg-aida-sidebar text-aida-text-2 hover:bg-aida-nav-active",
  soft: "bg-aida-nav-active text-[#c9d8ff] hover:brightness-125",
  danger: "bg-[#c8453f] text-white hover:brightness-110",
  ghost: "text-aida-text-3 hover:text-aida-text",
};

export function Btn({
  kind = "secondary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: ButtonKind }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-[10px] px-[18px] py-2.5 text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-40",
        BUTTON_KIND[kind],
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Page chrome ---------- */

export function Page({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-5 px-4 py-5 md:gap-6 md:px-9 md:py-7",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold leading-[34px] text-aida-text md:text-[28px]">
          {title}
        </h1>
        {subtitle ? (
          <p className="text-sm text-aida-muted">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-3">{actions}</div>
      ) : null}
    </header>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex w-full items-center md:w-[260px] gap-2 rounded-[10px] border border-aida-input-line bg-aida-sidebar px-3 py-[9px] focus-within:border-aida-primary-line">
      <Search className="size-4 text-aida-dim" strokeWidth={1.5} />
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] text-aida-text outline-none placeholder:text-aida-dim"
      />
    </label>
  );
}

export function FilterChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "rounded-full border px-3.5 py-1.5 text-[13px]",
        active
          ? "border-aida-primary-line bg-aida-primary-soft font-semibold text-aida-primary-text"
          : "border-aida-input-line font-medium text-aida-text-3 hover:bg-aida-nav-active/60",
      )}
    >
      {children}
    </button>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-aida-card-line bg-aida-surface",
        className,
      )}
    >
      {children}
    </section>
  );
}

export function Dot({ className }: { className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
    />
  );
}

export function EmptyPanel({
  icon,
  title,
  text,
  children,
}: {
  icon?: ReactNode;
  title: string;
  text: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3.5 rounded-2xl border border-aida-input-line bg-aida-surface-2 px-6 py-[72px] text-center">
      {icon ? (
        <div className="flex size-14 items-center justify-center rounded-[18px] bg-[#14203a] text-2xl font-medium text-aida-primary">
          {icon}
        </div>
      ) : null}
      <h2 className="text-xl font-semibold text-aida-text">{title}</h2>
      <p className="max-w-[460px] text-sm text-aida-muted">{text}</p>
      {children ? <div className="mt-1 flex gap-3">{children}</div> : null}
    </div>
  );
}

/* ---------- Form fields ---------- */

export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex items-baseline gap-3 text-[13px] font-medium text-aida-text-2">
        <span>{label}</span>
        {hint ? (
          <span className="text-xs font-normal text-aida-dim">{hint}</span>
        ) : null}
      </div>
      {children}
      {error ? <p className="text-xs text-aida-red">{error}</p> : null}
    </div>
  );
}

export function TextInput({
  invalid,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return (
    <input
      className={cn(
        "w-full rounded-[10px] border bg-aida-bg px-3.5 py-[11px] text-sm text-aida-text outline-none placeholder:text-aida-dim focus:border-aida-primary",
        invalid ? "border-aida-red" : "border-aida-input-line",
        className,
      )}
      {...props}
    />
  );
}

/* ---------- Modal ---------- */

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  width = 560,
  footer,
  tone,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: number;
  footer?: ReactNode;
  tone?: "danger";
}) {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-40 bg-[#05080f]/80" />
        <DialogPrimitive.Viewport className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 py-[8vh]">
          <DialogPrimitive.Popup
            style={{ maxWidth: width }}
            className={cn(
              "w-full rounded-[20px] border bg-aida-surface p-7 text-aida-text shadow-2xl outline-none",
              tone === "danger" ? "border-[#5a2a2c]" : "border-aida-card-line",
            )}
          >
            <div className="flex items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <DialogPrimitive.Title className="text-[22px] font-bold leading-7 text-aida-text">
                  {title}
                </DialogPrimitive.Title>
                {description ? (
                  <DialogPrimitive.Description className="text-sm text-aida-muted">
                    {description}
                  </DialogPrimitive.Description>
                ) : null}
              </div>
              <DialogPrimitive.Close
                aria-label="Close"
                className="flex size-8 shrink-0 items-center justify-center rounded-full bg-aida-nav-active/60 text-aida-text-3 hover:text-white"
              >
                <X className="size-4" strokeWidth={1.8} />
              </DialogPrimitive.Close>
            </div>
            {children ? <div className="mt-5">{children}</div> : null}
            {footer ? (
              <div className="mt-6 flex items-center justify-end gap-3">
                {footer}
              </div>
            ) : null}
          </DialogPrimitive.Popup>
        </DialogPrimitive.Viewport>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
