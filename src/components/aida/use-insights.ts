"use client";

import { useCallback, useEffect, useState } from "react";
import type { ActivityEvent, Funnel, OutcomeBar } from "@/lib/request-insights";

export interface Insights {
  caseType: "employee" | "client";
  funnel: Funnel;
  outcomes: OutcomeBar[];
  reanalysing: number;
  pst: Array<{
    id: string;
    name: string;
    emails: number;
    attachments: number;
    sizeBytes: number;
    status: string;
  }>;
  activity: ActivityEvent[];
}

/** Funnel, PST list and activity of a request; refreshed while it works. */
export function useInsights(requestId: string | null, live: boolean) {
  const [insights, setInsights] = useState<Insights | null>(null);
  const load = useCallback(async () => {
    if (!requestId) return;
    try {
      const response = await fetch(`/api/requests/${requestId}/insights`, {
        cache: "no-store",
      });
      if (response.ok) setInsights((await response.json()) as Insights);
    } catch {
      // The shell already shows when the connection is lost.
    }
  }, [requestId]);
  useEffect(() => {
    setInsights(null);
    void load();
  }, [load]);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => void load(), 5_000);
    return () => window.clearInterval(timer);
  }, [live, load]);
  return insights;
}
