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
          <span className="text-[13px] text-text-secondary">
            {users.length} {users.length === 1 ? "account" : "accounts"}
          </span>
        </div>
      </header>

      <main className="px-10 py-8">
        <UserLookupTable users={users} />
      </main>
    </div>
  );
}
