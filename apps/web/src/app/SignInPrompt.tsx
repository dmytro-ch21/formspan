"use client";

import { SignInButton } from "@clerk/nextjs";

export function SignInPrompt() {
  return (
    <SignInButton mode="modal">
      {/* `bg-foreground`/`text-background` were not in this app's @theme, so
          Tailwind emitted nothing for them and the page's only call to action
          rendered as plain black text on the grey ground. `accent-fill` /
          `accent-on-fill` is the pair the theme defines for exactly this. */}
      <button className="rounded-control bg-accent-fill px-5 py-2.5 text-sm font-semibold text-accent-on-fill transition hover:opacity-90">
        Sign in
      </button>
    </SignInButton>
  );
}
