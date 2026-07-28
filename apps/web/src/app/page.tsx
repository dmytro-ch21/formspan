"use client";

import { useEffect, useState } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";

type Healthz = { status: string; service: string };

export default function Home() {
  const [health, setHealth] = useState<Healthz | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/healthz`)
      .then((res) => {
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        return res.json();
      })
      .then(setHealth)
      .catch((err) => setError(String(err)));
  }, []);

  return (
    <main style={{ fontFamily: "sans-serif", padding: "2rem" }}>
      <h1>Formspan</h1>
      {error && <p style={{ color: "crimson" }}>Failed to reach API: {error}</p>}
      {!error && !health && <p>Loading API status…</p>}
      {health && (
        <p>
          API says: <strong>{health.service}</strong> is <strong>{health.status}</strong>
        </p>
      )}
    </main>
  );
}
