import Link from "next/link";

import { listUsers } from "@/lib/api";
import { UserLookupTable } from "./UserLookupTable";

export default async function UserLookupPage() {
  const users = await listUsers();

  return (
    <div className="min-h-screen w-full">
      <header className="flex w-full items-center justify-between border-b border-border bg-card px-10 py-5">
        <div className="flex items-center gap-4">
          <h1 className="font-barlow-condensed text-[17px] font-bold tracking-[0.1em] uppercase">
            User Lookup
          </h1>
          {/*
            Everyone the API has a row for anywhere — profile, session or
            activity — not just those with a `profiles` row. Someone who signed
            up and trained but never finished onboarding appears here, with no
            display name; they are precisely the account support gets asked
            about. Still not the same as "all accounts": someone who signed up
            and did nothing at all exists only in Clerk.
          */}
          <span className="text-[13px] text-text-secondary">
            {users.length} known to the API
          </span>
        </div>
        <Link href="/health" className="text-[13px] text-text-secondary underline">
          Health
        </Link>
      </header>

      <main className="px-10 py-8">
        <UserLookupTable users={users} />
      </main>
    </div>
  );
}
