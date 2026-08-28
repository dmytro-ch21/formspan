"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { getClassPlan, type ClassPlan } from "@/lib/api";
import { ClassPlanBuilder } from "../../ClassPlanBuilder";

/**
 * Edit loads the plan first and only then mounts the builder.
 *
 * `existing` seeds the builder's state through useState initialisers, which
 * run once — so handing it an undefined-then-loaded prop would leave every
 * field empty and a save would wipe the plan. Gating the mount is what makes
 * the initialiser see real data. Matches `sequences/[id]/edit/page.tsx`.
 *
 * No `editable` gate, unlike the sequence editor. This domain has no
 * VOLA-authored rows and no sharing — `getClassPlan` 404s outright for a plan
 * the caller does not own (classplan.go: "not owned" and "does not exist" are
 * the same case on every path), so there is no reachable state here where a
 * plan loaded successfully and still is not the caller's to edit.
 */
export default function EditClassPlanPage() {
  const { getToken } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [p, setP] = useState<ClassPlan | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const ctl = new AbortController();
    getClassPlan(getToken, id, ctl.signal)
      .then(setP)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => ctl.abort();
  }, [getToken, id]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  if (!p) return <p className="text-sm text-text-muted">Loading…</p>;
  // `key`, so navigating edit→edit REMOUNTS rather than reusing the instance:
  // an already-mounted builder would keep the previous plan's
  // initialiser-seeded fields and a save would write A's schedule over B's.
  return <ClassPlanBuilder key={p.id} existing={p} />;
}
