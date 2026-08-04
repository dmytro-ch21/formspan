import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SignInPrompt } from "./SignInPrompt";
import { VolaLockup } from "./Brand";

export default async function Home() {
  const { userId } = await auth();
  if (userId) {
    redirect("/users");
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6">
      {/* The visible content *is* the heading, rather than a visually-hidden
          "VOLA Admin" sitting beside it. Both arrangements expose one
          accessible name, but the hidden-duplicate version makes a linear
          screen-reader pass announce "VOLA Admin, heading level 1" and then,
          a beat later, the still-exposed visible "Admin" — a stutter, and the
          visible text has no programmatic relationship to the heading it
          duplicates. `aria-label` on the h1 covers both: the lockup is
          `aria-hidden` inside it, and "Admin" is named as part of the heading
          rather than announced again after it. */}
      <h1 aria-label="VOLA Admin" className="flex flex-col items-center gap-3">
        <VolaLockup width={148} />
        {/* "Admin" stays type rather than becoming part of the lockup — it is a
            qualifier on which console you are looking at, not part of the mark,
            and baking it into the artwork would invent a logo the brand kit
            does not have. `text-button-text` rather than `text-text-secondary`:
            the latter is 4.41:1 against this page at 14px bold, just under the
            4.5:1 it needs at that size. */}
        <span className="font-barlow-condensed text-button-text text-sm font-bold tracking-[0.22em] uppercase">
          Admin
        </span>
      </h1>
      <SignInPrompt />
    </main>
  );
}
