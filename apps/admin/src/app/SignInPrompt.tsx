"use client";

import { SignInButton } from "@clerk/nextjs";

export function SignInPrompt() {
  return (
    <SignInButton mode="modal">
      <button className="rounded-[9px] bg-accent-dark px-5 py-3 font-barlow-condensed text-[11px] font-semibold tracking-[0.14em] text-accent-lime uppercase">
        Sign in
      </button>
    </SignInButton>
  );
}
