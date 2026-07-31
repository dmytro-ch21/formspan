import { currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

/**
 * Same allowlist as `/users`, for the same reason and with the same caveat:
 * this gate is defence in depth for the UI, and the real security boundary is
 * the backend's own `auth.RequireAdmin` on `GET /v1/admin/health`.
 *
 * Duplicated rather than shared because `proxy.ts` matches routes by path and
 * a shared layout would have to sit above both, which would put the gate on
 * the public entry page too.
 */
function isAllowedAdmin(userId: string | undefined): boolean {
  if (!userId) return false;
  const allowlist = (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return allowlist.includes(userId);
}

export default async function HealthLayout({
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
          {user?.id ?? "This account"} isn&apos;t on the admin allowlist. Ask an existing admin to
          add it to <code>ADMIN_USER_IDS</code>.
        </p>
        <UserButton />
      </main>
    );
  }

  return <>{children}</>;
}
