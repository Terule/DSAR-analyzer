"use client";

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/** Safety net for unmounting: the animation end normally does it first. */
const CLOSE_MS = 400;

/**
 * Side panel over the page. It slides in from the right and slides back out
 * to the right while the dark side fades with it, using keyframe animations
 * that start in the very frame the panel is drawn (so a heavy panel, or a
 * reopening right after a close, never skips them). Closes with Escape or a
 * click on the dark side. The last content and width stay while it leaves,
 * because the parent has already cleared them by then.
 */
export function Drawer({
  open,
  onClose,
  width = 560,
  crumb,
  children,
}: {
  open: boolean;
  onClose: () => void;
  width?: number;
  /** Phone only: the page the panel sits on, shown as a back link. */
  crumb?: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(open);
  const last = useRef<ReactNode>(children);
  if (open) last.current = children;
  const lastWidth = useRef(width);
  if (open) lastWidth.current = width;

  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setMounted(false), CLOSE_MS + 150);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Drawn the moment it opens, and kept until it has left.
  if (!open && !mounted) return null;
  const easing = "cubic-bezier(0.4, 0, 0.2, 1)";
  return (
    <div className={cn("fixed inset-0 z-30", !open && "pointer-events-none")}>
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        style={{
          animation: open
            ? `aida-fade-in var(--aida-drawer-in) ${easing} both`
            : `aida-fade-out var(--aida-drawer-out) ${easing} both`,
        }}
        className="absolute inset-0 cursor-default bg-[#05080f]/75"
      />
      <aside
        style={{
          width: `min(${open ? width : lastWidth.current}px, 100vw)`,
          animation: open
            ? `aida-drawer-in var(--aida-drawer-in) ${easing} both`
            : `aida-drawer-out var(--aida-drawer-out) ${easing} both`,
        }}
        onAnimationEnd={(event) => {
          if (!open && event.currentTarget === event.target) setMounted(false);
        }}
        className="absolute inset-y-0 right-0 flex flex-col overflow-y-auto border-l border-aida-primary-line/40 bg-aida-sidebar"
      >
        {crumb ? (
          <button
            type="button"
            onClick={onClose}
            className="w-fit px-6 pt-5 text-[13px] font-medium text-aida-primary-text sm:hidden"
          >
            ‹ {crumb}
          </button>
        ) : null}
        {open ? children : last.current}
      </aside>
    </div>
  );
}

const SLIDE_MS = 450;

type Phase =
  | "idle"
  | "enter-right"
  | "enter-left"
  | "leave-left"
  | "leave-right";

interface Layer {
  key: string;
  depth: number;
  node: ReactNode;
  phase: Phase;
}

/** Keyframes live in globals.css; both layers get theirs in the same commit, so they move together. */
const ANIMATION: Record<Phase, string | undefined> = {
  idle: undefined,
  "enter-right": "aida-slide-in-right",
  "enter-left": "aida-slide-in-left",
  "leave-left": "aida-slide-out-left",
  "leave-right": "aida-slide-out-right",
};

/**
 * Views inside an open drawer, one level deeper each time (reasons, then the
 * items of a reason, then one item). Going deeper slides the current view out
 * to the left while the next one comes in from the right; going back does the
 * opposite. A change at the same depth swaps at once. The view coming in is
 * always on top and every view has its own background, so two of them can
 * never be seen through each other.
 */
export function SlideStack({
  viewKey,
  depth,
  children,
}: {
  viewKey: string;
  depth: number;
  children: ReactNode;
}) {
  const [layers, setLayers] = useState<Layer[]>(() => [
    { key: viewKey, depth, node: children, phase: "idle" },
  ]);
  const top = layers[layers.length - 1];

  // Only a change of view starts a slide; `top` and `children` are read once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (viewKey === top.key) return;
    if (depth === top.depth) {
      setLayers([{ key: viewKey, depth, node: children, phase: "idle" }]);
      return;
    }
    const deeper = depth > top.depth;
    setLayers((current) => [
      {
        ...current[current.length - 1],
        phase: deeper ? "leave-left" : "leave-right",
      },
      {
        key: viewKey,
        depth,
        node: children,
        phase: deeper ? "enter-right" : "enter-left",
      },
    ]);
    // Safety net in case an animation end is never reported.
    const timer = window.setTimeout(
      () => setLayers((current) => current.filter((l) => l.key === viewKey)),
      SLIDE_MS + 150,
    );
    return () => window.clearTimeout(timer);
  }, [viewKey]);

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      {layers.map((layer, index) => {
        const leaving = layer.phase.startsWith("leave");
        const animation = ANIMATION[layer.phase];
        return (
          <div
            key={layer.key}
            style={{
              zIndex: index,
              animation: animation
                ? `${animation} var(--aida-slide-duration) cubic-bezier(0.4, 0, 0.2, 1) both`
                : undefined,
            }}
            onAnimationEnd={() =>
              setLayers((current) =>
                leaving
                  ? current.filter((l) => l.key !== layer.key)
                  : current.map((l) =>
                      l.key === layer.key ? { ...l, phase: "idle" } : l,
                    ),
              )
            }
            className={cn(
              "absolute inset-0 overflow-y-auto bg-aida-sidebar",
              leaving && "pointer-events-none",
            )}
          >
            {layer.key === viewKey ? children : layer.node}
          </div>
        );
      })}
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
