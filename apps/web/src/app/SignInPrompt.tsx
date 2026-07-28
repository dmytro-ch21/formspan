"use client";

import { SignInButton } from "@clerk/nextjs";

export function SignInPrompt() {
  return (
    <SignInButton mode="modal">
      <button className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
        Sign in
      </button>
    </SignInButton>
  );
}
