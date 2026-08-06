"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";

import { getSequence, type Sequence } from "@/lib/api";
import { SequenceBuilder } from "../../SequenceBuilder";

/**
 * Edit loads the sequence first and only then mounts the builder.
 *
 * `existing` seeds the builder's state through useState initialisers, which run
 * once — so handing it an undefined-then-loaded prop would leave every field
 * empty and a save would wipe the chain. Gating the mount is what makes the
 * initialiser see real data. Same reasoning as the curriculum editor, and the
 * consequence here is worse: an empty `steps` array is a legal request that
 * CLEARS the chain rather than being rejected.
 */
export default function EditSequencePage() {
  const { getToken } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const [s, setS] = useState<Sequence | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    const ctl = new AbortController();
    getSequence(getToken, id, ctl.signal)
      .then(setS)
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
  if (!s) return <p className="text-sm text-neutral-500">Loading…</p>;
  if (!s.editable) {
    // A VOLA-authored reference chain. The API answers 403 on the write, but
    // letting the builder mount would offer a Save that cannot succeed.
    return (
      <p className="text-sm text-neutral-500">
        This is a reference sequence and cannot be edited. Copy it to make it
        yours.
      </p>
    );
  }
  // `key`, so navigating edit→edit REMOUNTS rather than reusing the instance:
  // the gate above only covers the first load, so an already-mounted builder
  // would keep the previous sequence's initialiser-seeded fields and a save
  // would write A's chain over B.
  return <SequenceBuilder key={s.id} existing={s} />;
}
