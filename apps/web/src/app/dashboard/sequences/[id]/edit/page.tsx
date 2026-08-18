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
    // The GATE stays on `editable`, and that is the correct use of it: you may
    // not edit this whoever wrote it, and letting the builder mount would offer
    // a Save the API answers 403 to.
    //
    // Only the MESSAGE was making an authorship claim — "This is a reference
    // sequence" says VOLA wrote it, which `!editable` does not know. It asks
    // `official` for that half now and falls back to saying only what it can
    // actually see. T9; the same split F7 drew for curricula.
    return (
      <p className="text-sm text-neutral-500">
        {/* No "Copy it to make it yours" — review found that sentence naming an
            affordance that does not exist. There is no copy button for
            sequences anywhere in this app, and no endpoint behind one either:
            `CopyTo` is reachable only by ACCEPTING a share from a friend. It
            was pre-existing copy and this branch would have duplicated it into
            a second branch. Filed as F9. */}
        {s.official
          ? "This is a reference sequence and cannot be edited."
          : "This sequence cannot be edited."}
      </p>
    );
  }
  // `key`, so navigating edit→edit REMOUNTS rather than reusing the instance:
  // the gate above only covers the first load, so an already-mounted builder
  // would keep the previous sequence's initialiser-seeded fields and a save
  // would write A's chain over B.
  return <SequenceBuilder key={s.id} existing={s} />;
}
