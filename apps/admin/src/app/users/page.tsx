import { listUsers } from "@/lib/api";
import { AdminMasthead } from "../AdminMasthead";
import { UserLookupTable } from "./UserLookupTable";

export default async function UserLookupPage() {
  const users = await listUsers();

  return (
    <div className="min-h-screen w-full">
      <AdminMasthead
        title="User Lookup"
        section="users"
        meta={
          /*
            Everyone the API has a row for anywhere — profile, session or
            activity — not just those with a `profiles` row. Someone who signed
            up and trained but never finished onboarding appears here, with no
            display name; they are precisely the account support gets asked
            about. Still not the same as "all accounts": someone who signed up
            and did nothing at all exists only in Clerk.
          */
          `${users.length} known to the API`
        }
      />

      <main className="px-10 py-8">
        <UserLookupTable users={users} />
      </main>
    </div>
  );
}
