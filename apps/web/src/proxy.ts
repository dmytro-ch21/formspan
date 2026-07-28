import { clerkMiddleware } from "@clerk/nextjs/server";

// Not gating any routes yet — just makes auth() available everywhere.
// The home page below decides for itself what to show signed-in vs. out.
export default clerkMiddleware();

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
