import { currentUser } from "@clerk/nextjs/server";

import { isAllowedAdmin } from "@/lib/admin";
import { NotAuthorized } from "../NotAuthorized";

export default async function HealthLayout({
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
