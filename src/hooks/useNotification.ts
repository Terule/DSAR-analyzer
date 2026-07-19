"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import type { AppNotification } from "@/lib/types";

export function useNotification() {
  const setNotification = useCallback((notification: AppNotification) => {
    toast[notification.type](notification.message);
  }, []);

  return { setNotification };
}
