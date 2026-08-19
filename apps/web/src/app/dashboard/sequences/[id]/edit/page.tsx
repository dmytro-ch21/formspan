"use client";

import Link from "next/link";
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
        {/* The instruction is back, and now there is something behind it: F9
            added `POST /sequences/{id}/copy` and the button on the detail
            page. It was removed in #289 precisely because it named an
            affordance that did not exist — so it says where the button IS
            rather than telling you to copy and leaving you to find out how. */}
        {s.official
          ? "This is a reference sequence and cannot be edited. "
          : "This sequence cannot be edited. "}
        {/* A link, not the words "its page". This route is only reachable by
            typing the URL — the detail page hides Edit when you cannot edit —
            so the reader arrived WITHOUT passing the page being pointed at.
            The sentence exists to name a reachable affordance; one click beats
            a treasure hunt. */}
        <Link href={`/dashboard/sequences/${s.id}`} className="underline">
          Copy it from its page
        </Link>{" "}
        to make it yours.
      </p>
    );
  }
  // `key`, so navigating edit→edit REMOUNTS rather than reusing the instance:
  // the gate above only covers the first load, so an already-mounted builder
  // would keep the previous sequence's initialiser-seeded fields and a save
  // would write A's chain over B.
  return <SequenceBuilder key={s.id} existing={s} />;
}
