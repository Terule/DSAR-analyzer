"use client";

import { useEffect, useRef, useState } from "react";
import type { StagedFile } from "@/lib/types";

export function useFileStream() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const lastPayloadRef = useRef("");

  useEffect(() => {
    const evtSource = new EventSource("/api/events");
    evtSource.onmessage = (event) => {
      if (event.data === lastPayloadRef.current) {
        setLoading(false);
        return;
      }

      lastPayloadRef.current = event.data;
      const data = JSON.parse(event.data) as StagedFile[];
      setFiles(data);
      setLoading(false);
    };
    return () => evtSource.close();
  }, []);

  return { files, loading };
}
