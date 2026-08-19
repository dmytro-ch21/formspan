import { NutritionNav } from "./NutritionNav";

/**
 * The nutrition section shell.
 *
 * A Server Component with no data of its own — the sub-nav is a Client
 * Component because it reads the pathname, and keeping the shell on the server
 * means this file never becomes the place somebody adds a fetch that then runs
 * on every child navigation.
 */
export default function NutritionLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <h1 className="font-display text-3xl uppercase tracking-tight">Nutrition</h1>
        <NutritionNav />
      </div>
      {children}
    </div>
  );
}
