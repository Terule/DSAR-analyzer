"use client";

import { Clock, Folder, SlidersHorizontal } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ConnectionLost } from "./ConnectionLost";
import { CasesProvider, useCases } from "./cases-context";

const NAV = [
  {
    href: "/",
    label: "Cases",
    icon: Folder,
    match: (p: string) => p === "/" || p.startsWith("/cases"),
  },
  {
    href: "/history",
    label: "History",
    icon: Clock,
    match: (p: string) => p.startsWith("/history"),
  },
  {
    href: "/settings",
    label: "Settings",
    icon: SlidersHorizontal,
    match: (p: string) => p.startsWith("/settings"),
  },
];

function formatFree(bytes: number | null): string {
  if (bytes === null) return "";
  const gb = bytes / 1024 ** 3;
  return gb >= 100 ? `${Math.round(gb)} GB free` : `${gb.toFixed(1)} GB free`;
}

function SystemStatus() {
  const { offline } = useCases();
  const [free, setFree] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/system-status", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { freeBytes: number | null }) => {
          if (!cancelled) setFree(body.freeBytes);
        })
        .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);
  const low = free !== null && free < 20 * 1024 ** 3;
  return (
    <div className="flex flex-col gap-1 rounded-[10px] border border-aida-line bg-aida-surface p-3">
      <div className="flex items-center gap-2 text-xs font-medium text-aida-text-2">
        <span
          className={cn(
            "size-[7px] rounded-full",
            offline
              ? "bg-aida-red"
              : low
                ? "bg-aida-amber"
                : "bg-aida-green-dot",
          )}
        />
        {offline
          ? "Connection lost"
          : low
            ? "Low disk space"
            : "System running"}
      </div>
      <div className="pl-[15px] text-[11px] text-aida-muted">
        Bedrock{free !== null ? ` · ${formatFree(free)}` : ""}
      </div>
    </div>
  );
}

function Sidebar() {
  const pathname = usePathname();
  return (
    <aside className="hidden h-full w-[232px] shrink-0 flex-col justify-between border-r border-aida-line bg-aida-sidebar p-5 md:flex">
      <div className="flex flex-col gap-7">
        <div className="flex items-center gap-2.5">
          <div className="size-7 rounded-lg bg-aida-primary/0" aria-hidden />
          <span className="-ml-[0px] text-[17px] font-bold tracking-[0.5px] text-aida-text">
            AIDA
          </span>
        </div>
        <nav className="flex flex-col gap-1">
          {NAV.map((item) => {
            const active = item.match(pathname);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-2.5 rounded-lg px-3 py-[9px] text-sm",
                  active
                    ? "bg-aida-nav-active font-semibold text-white"
                    : "font-medium text-aida-text-3 hover:bg-aida-nav-active/60",
                )}
              >
                <Icon
                  className={cn(
                    "size-[18px]",
                    active ? "text-aida-primary-text" : "text-aida-muted",
                  )}
                  strokeWidth={1.5}
                />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <SystemStatus />
    </aside>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { offline } = useCases();
  return (
    <div className="flex h-full">
      <Sidebar />
      <main className="relative h-full min-w-0 flex-1 overflow-y-auto">
        {children}
        {offline ? <ConnectionLost /> : null}
      </main>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <CasesProvider>
      <Frame>{children}</Frame>
    </CasesProvider>
  );
}
