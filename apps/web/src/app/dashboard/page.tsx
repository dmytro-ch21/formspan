"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Healthz = { status: string; service: string };
type Me = { user_id: string };

export default function DashboardPage() {
  // One trace ID for the whole page view — shared with MePanel below so
  // both requests this page makes correlate in the backend's logs.
  const [traceId] = useState(newTraceId);
  const [health, setHealth] = useState<Healthz | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_BASE}/healthz`, { headers: { traceparent: traceparent(traceId) } })
      .then((res) => {
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err) => setError(String(err)));
  }, [traceId]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">Dashboard</h1>
      {error && <p className="text-red-600">Failed to reach API: {error}</p>}
      {!error && !health && <p className="text-black/60 dark:text-white/60">Loading API status…</p>}
      {health && (
        <p>
          API says: <strong>{health.service}</strong> is <strong>{health.status}</strong>
        </p>
      )}
      <MePanel traceId={traceId} />
    </div>
  );
}

function MePanel({ traceId }: { traceId: string }) {
  const { getToken } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      try {
        const res = await fetch(`${API_BASE}/me`, {
          headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(traceId) },
        });
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        setMe(await res.json());
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [getToken, traceId]);

  return (
    <div>
      {error && <p className="text-red-600">Failed to reach /me: {error}</p>}
      {!error && !me && <p className="text-black/60 dark:text-white/60">Loading /me…</p>}
      {me && (
        <p>
          API verified you as user <strong>{me.user_id}</strong>
        </p>
      )}
    </div>
  );
}
