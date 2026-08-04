import { currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";

import { isAllowedAdmin } from "@/lib/admin";

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
