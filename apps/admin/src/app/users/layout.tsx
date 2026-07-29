import { currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

/**
 * Matches the backend's ADMIN_USER_IDS allowlist (auth.RequireAdmin) — one
 * admin-identity convention across the stack, keyed by Clerk user ID rather
 * than email so both sides check the same thing.
 *
 * This gate is defence in depth for the UI. The real security boundary is
 * the backend's own check: these screens only render data the API agreed to
 * return, and the API independently rejects non-admin callers.
 */
function isAllowedAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const allowlist = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowlist.includes(userId);
}

export default async function UsersLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await currentUser();

  if (!isAllowedAdmin(user?.id)) {
    return (
      <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-3 text-center">
        <h1 className="font-barlow-condensed text-2xl font-bold tracking-[0.06em] uppercase">
          Not authorized
        </h1>
        <p className="max-w-sm text-sm text-text-secondary">
          {user?.id ?? "This account"} isn&apos;t on the admin allowlist. Ask an existing admin
          to add it to <code>ADMIN_USER_IDS</code>.
        </p>
        <UserButton />
      </main>
    );
  }

  return <>{children}</>;
}
