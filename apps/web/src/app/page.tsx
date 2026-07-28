import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { SignInPrompt } from "./SignInPrompt";

export default async function Home() {
  const { userId } = await auth();
  if (userId) {
    redirect("/dashboard");
  }

  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-6">
      <h1 className="text-3xl font-bold">Formspan</h1>
      <SignInPrompt />
    </main>
  );
}
