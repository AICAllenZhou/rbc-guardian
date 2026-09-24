"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, GatewayError, type CaseView } from "./gateway";

export interface LiveCase {
  view: CaseView | null;
  loading: boolean;
  error: string | null;
  notFound: boolean;
  streaming: boolean;
  refresh(): Promise<void>;
}

/**
 * Loads a case view and keeps it live over SSE. Every event triggers a debounced
 * refetch of the full view, so the UI always renders one consistent snapshot.
 */
export function useCase(caseId: string | null): LiveCase {
  const [view, setView] = useState<CaseView | null>(null);
  const [loading, setLoading] = useState(!!caseId);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!caseId) {
      setView(null);
      setLoading(false);
      return;
    }
    try {
      const v = await api.caseView(caseId);
      setView(v);
      setError(null);
      setNotFound(false);
    } catch (err) {
      if (err instanceof GatewayError && err.status === 404) {
        setView(null);
        setNotFound(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Could not load the case.");
      }
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    setLoading(!!caseId);
    void refresh();
    if (!caseId || typeof EventSource === "undefined") return;
    // Subscribe to every case so a reset or detection is seen even before this case exists.
    const es = new EventSource(api.eventsUrl("*"));
    es.onopen = () => setStreaming(true);
    es.onerror = () => setStreaming(false);
    const schedule = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void refresh(), 120);
    };
    es.addEventListener("event", schedule);
    es.addEventListener("case", schedule);
    es.addEventListener("reset", schedule);
    return () => {
      es.close();
      setStreaming(false);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [caseId, refresh]);

  return { view, loading, error, notFound, streaming, refresh };
}
