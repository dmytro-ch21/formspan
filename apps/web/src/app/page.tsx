"use client";

import { useEffect, useState } from "react";
import { SignInButton, UserButton, useAuth } from "@clerk/nextjs";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const API_BASE = `${API_URL}/v1`;

type Healthz = { status: string; service: string };
type Me = { user_id: string };

export default function Home() {
  const [health, setHealth] = useState<Healthz | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { isLoaded, isSignedIn } = useAuth();

  useEffect(() => {
    fetch(`${API_BASE}/healthz`)
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

      {!isLoaded && <p>Loading auth…</p>}
      {isLoaded && !isSignedIn && <SignInButton mode="modal" />}
      {isLoaded && isSignedIn && (
        <>
          <UserButton />
          <MePanel />
        </>
      )}
    </main>
  );
}

function MePanel() {
  const { getToken } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const token = await getToken();
      try {
        const res = await fetch(`${API_BASE}/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`API responded ${res.status}`);
        setMe(await res.json());
      } catch (err) {
        setError(String(err));
      }
    })();
  }, [getToken]);

  return (
    <div>
      {error && <p style={{ color: "crimson" }}>Failed to reach /me: {error}</p>}
      {!error && !me && <p>Loading /me…</p>}
      {me && (
        <p>
          API verified you as user <strong>{me.user_id}</strong>
        </p>
      )}
    </div>
  );
}
