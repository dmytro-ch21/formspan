import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SignInPrompt } from "./SignInPrompt";
import { VolaLockup } from "./Brand";

export default async function Home() {
  const { userId } = await auth();
  if (userId) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6">
      {/* The heading is still a heading — the lockup is decorative and the
          accessible name lives here, so this reads as "VOLA, heading level 1"
          rather than announcing two SVGs. */}
      <h1 className="sr-only">VOLA</h1>
      <VolaLockup width={160} />
      <SignInPrompt />
    </main>
  );
}
