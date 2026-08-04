import { currentUser } from "@clerk/nextjs/server";

import { isAllowedAdmin } from "@/lib/admin";
import { NotAuthorized } from "../NotAuthorized";

/**
 * Same gate as `/users`, sharing the same allowlist helper.
 *
 * Defence in depth for the UI — the backend's RequireAdmin is the real
 * boundary, and these screens only render what the API agreed to return. Note
 * this layout does NOT protect the server actions in `actions.ts`: those are
 * their own endpoints and check `assertAdmin` themselves.
 */
export default async function ContentLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const user = await currentUser();

  if (!isAllowedAdmin(user?.id)) {
    return <NotAuthorized userId={user?.id} />;
  }

  return <>{children}</>;
}
