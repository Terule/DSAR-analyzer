"use client";

import { useEffect, useState } from "react";
import type { StagedFile } from "@/lib/types";

export function useFileStream() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const evtSource = new EventSource("/api/events");
    evtSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      setFiles(data);
      setLoading(false);
    };
    return () => evtSource.close();
  }, []);

  return { files, loading };
}
