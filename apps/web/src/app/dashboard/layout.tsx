import Link from "next/link";
import { UserButton } from "@clerk/nextjs";

const navItems = [{ href: "/dashboard", label: "Dashboard" }];

export default function DashboardLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex min-h-screen flex-1">
      <aside className="flex w-56 flex-col justify-between border-r border-black/10 p-4 dark:border-white/10">
        <div>
          <span className="text-lg font-bold">Formspan</span>
          <nav className="mt-8 flex flex-col gap-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-md px-3 py-2 text-sm font-medium hover:bg-black/5 dark:hover:bg-white/10"
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
        <UserButton />
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  );
}
