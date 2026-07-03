"use client";

import { useEffect, useRef, useState } from "react";
import type { StagedFile } from "@/lib/types";

export function useFileStream() {
  const [files, setFiles] = useState<StagedFile[]>([]);
  const [loading, setLoading] = useState(true);
  const lastPayloadRef = useRef("");
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let closed = false;

    const handleMessage = (event: MessageEvent) => {
      if (event.data === lastPayloadRef.current) {
        setLoading(false);
        return;
      }
      lastPayloadRef.current = event.data;
      try {
        setFiles(JSON.parse(event.data) as StagedFile[]);
      } catch {
        // Ignore a malformed frame; the next tick carries a full snapshot.
      }
      setLoading(false);
    };

    const connect = () => {
      if (closed) return;
      sourceRef.current?.close();
      // Force the first frame after (re)connect to always apply.
      lastPayloadRef.current = "";
      const es = new EventSource("/api/events");
      es.onmessage = handleMessage;
      es.onerror = () => {
        // The browser auto-reconnects on transient drops (readyState CONNECTING).
        // If it gave up (CLOSED) — e.g. the server hot-reloaded or the machine
        // slept — recreate the stream after a short backoff so the UI can't get
        // stuck on a stale snapshot.
        if (es.readyState === EventSource.CLOSED && !closed) {
          setTimeout(connect, 2000);
        }
      };
      sourceRef.current = es;
    };

    // When the tab returns to the foreground (e.g. after sleep), reconnect if the
    // stream died while it was hidden.
    const handleVisibility = () => {
      if (
        document.visibilityState === "visible" &&
        sourceRef.current?.readyState === EventSource.CLOSED
      ) {
        connect();
      }
    };

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      closed = true;
      document.removeEventListener("visibilitychange", handleVisibility);
      sourceRef.current?.close();
    };
  }, []);

  return { files, loading };
}
