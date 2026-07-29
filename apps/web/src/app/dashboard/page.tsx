"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { newTraceId, traceparent } from "@/lib/trace";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Healthz = { status: string; service: string };
type Me = { user_id: string };
type Activity = {
  id: string;
  kind: string;
  occurred_at: string;
  notes: string | null;
};

// Fixed locale + zone: the default `toLocaleString()` resolves differently
// during SSR than in the browser, which mismatches on hydration.
const UTC_FORMAT = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});

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
      <ActivitiesPanel traceId={traceId} />
    </div>
  );
}

/**
 * The receiving end of the mobile app's offline sync — activities logged on
 * a phone (possibly while offline) and pushed to /v1/activities show up here
 * once synced.
 */
function ActivitiesPanel({ traceId }: { traceId: string }) {
  const { getToken } = useAuth();
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(`${API_BASE}/activities`, {
          headers: { Authorization: `Bearer ${token}`, traceparent: traceparent(traceId) },
        });
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        const data = await res.json();
        setActivities(data.activities ?? []);
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [getToken, traceId]);

  return (
    <section className="flex flex-col gap-2 pt-4">
      <h2 className="text-lg font-semibold">Your activities</h2>

      {error && <p className="text-red-600">Failed to load activities: {error}</p>}
      {!error && activities === null && (
        <p className="text-black/60 dark:text-white/60">Loading activities…</p>
      )}
      {activities?.length === 0 && (
        <p className="text-black/60 dark:text-white/60">
          Nothing yet — log an activity in the mobile app and sync it.
        </p>
      )}

      {activities && activities.length > 0 && (
        <ul className="flex flex-col gap-2">
          {activities.map((a) => (
            <li
              key={a.id}
              className="flex items-baseline justify-between gap-4 border-b border-black/10 pb-2 dark:border-white/10"
            >
              <span className="font-medium">{a.kind}</span>
              <span className="flex-1 text-sm text-black/60 dark:text-white/60">
                {a.notes ?? "No notes"}
              </span>
              <span className="text-sm text-black/60 dark:text-white/60">
                {UTC_FORMAT.format(new Date(a.occurred_at))} UTC
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
