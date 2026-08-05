"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { getCurriculum, type Curriculum } from "@/lib/api";
import { CurriculumBuilder } from "../../CurriculumBuilder";

/**
 * Edit loads the curriculum first and only then mounts the builder.
 *
 * `existing` seeds the builder's state through useState initialisers, which run
 * once — so handing it an undefined-then-loaded prop would leave every field
 * empty and a save would wipe the curriculum. Gating the mount is what makes
 * the initialiser see real data.
 */
export default function EditCurriculumPage() {
  const { getToken } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [c, setC] = useState<Curriculum | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const ctl = new AbortController();
    getCurriculum(getToken, id, ctl.signal)
      .then(setC)
      .catch((err) => {
        if ((err as Error)?.name !== "AbortError") {
          setError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => ctl.abort();
  }, [getToken, id]);

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-300">
        {error}
      </p>
    );
  }
  if (!c) return <p className="text-sm text-neutral-500">Loading…</p>;
  return <CurriculumBuilder existing={c} />;
}
