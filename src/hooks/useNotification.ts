"use client";

import { useEffect, useState } from "react";
import type { AppNotification } from "@/lib/types";

export function useNotification(timeoutMs = 5000) {
  const [notification, setNotification] = useState<AppNotification | null>(
    null,
  );

  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => setNotification(null), timeoutMs);
      return () => clearTimeout(timer);
    }
  }, [notification, timeoutMs]);

  return { notification, setNotification };
}
