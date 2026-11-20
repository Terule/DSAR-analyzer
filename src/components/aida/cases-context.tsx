"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { needsPolling } from "@/lib/dashboard-polling";
import type { CaseItem } from "./types";

interface CasesState {
  cases: CaseItem[];
  /** True until the first answer (or failure) of the case list arrives. */
  loading: boolean;
  /** Set when the list could not be loaded, so the screen can say so. */
  offline: boolean;
  busy: string | null;
  refresh: (silent?: boolean) => Promise<void>;
  /** Runs one API call, refreshes the list and reports failures as a toast. */
  call: (
    key: string,
    url: string,
    init?: RequestInit,
  ) => Promise<Record<string, unknown> | null>;
  privacyMode: boolean;
  setPrivacyMode: (value: boolean) => void;
}

const CasesContext = createContext<CasesState | null>(null);

export function useCases(): CasesState {
  const value = useContext(CasesContext);
  if (!value) throw new Error("useCases needs a CasesProvider.");
  return value;
}

/**
 * Holds the case list for every screen, so moving between the list and a case
 * does not refetch, and one poller keeps running requests current.
 */
export function CasesProvider({ children }: { children: ReactNode }) {
  const [cases, setCases] = useState<CaseItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [privacyMode, setPrivacyModeState] = useState(false);
  const failures = useRef(0);

  useEffect(() => {
    try {
      setPrivacyModeState(window.localStorage.getItem("aida.privacy") === "1");
    } catch {
      // Storage can be blocked; privacy mode then simply starts off.
    }
  }, []);
  const setPrivacyMode = useCallback((value: boolean) => {
    setPrivacyModeState(value);
    try {
      window.localStorage.setItem("aida.privacy", value ? "1" : "0");
    } catch {
      // Not persisted; the choice still applies to this page.
    }
  }, []);

  const refresh = useCallback(async (silent = false) => {
    try {
      const response = await fetch("/api/cases?status=active", {
        cache: "no-store",
      });
      const text = await response.text();
      let data: { cases?: CaseItem[]; error?: string } = {};
      try {
        data = text ? (JSON.parse(text) as typeof data) : {};
      } catch {
        throw new Error("The case list returned an invalid response.");
      }
      if (!response.ok) throw new Error(data.error || "Unable to load cases.");
      setCases(data.cases || []);
      failures.current = 0;
      setOffline(false);
    } catch (error) {
      failures.current += 1;
      // One failed poll is noise; two in a row means the connection is gone.
      if (failures.current >= 2 || !silent) setOffline(true);
      if (!silent) {
        toast.error(
          error instanceof Error ? error.message : "Unable to load cases.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    // Keep polling while the connection is lost so the screen recovers by itself.
    if (!offline && !needsPolling(cases)) return;
    const timer = window.setInterval(
      () => void refresh(true),
      offline ? 10_000 : 5_000,
    );
    return () => window.clearInterval(timer);
  }, [cases, offline, refresh]);

  const call = useCallback(
    async (key: string, url: string, init?: RequestInit) => {
      setBusy(key);
      try {
        const response = await fetch(url, {
          ...init,
          headers: {
            "Content-Type": "application/json",
            ...(init?.headers || {}),
          },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Request failed.");
        await refresh(true);
        return data as Record<string, unknown>;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Request failed.");
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const value = useMemo(
    () => ({
      cases,
      loading,
      offline,
      busy,
      refresh,
      call,
      privacyMode,
      setPrivacyMode,
    }),
    [cases, loading, offline, busy, refresh, call, privacyMode, setPrivacyMode],
  );
  return (
    <CasesContext.Provider value={value}>{children}</CasesContext.Provider>
  );
}
