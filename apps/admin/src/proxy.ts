import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Every admin surface, not just the first one that existed. `/health` shows
// error messages and user ids across the whole fleet, so leaving it out of the
// matcher would mean a signed-out visitor reached the layout's own allowlist
// check instead of a sign-in prompt — the layout does refuse them, but the
// gate belongs here where "protected" is declared once rather than per screen.
//
// `/content` is the first surface here that WRITES. Its server actions run
// their own `assertAdmin` rather than trusting this matcher or the layout: a
// server action is an endpoint the router exposes independently of the page it
// was declared beside, so route-level protection does not reach it.
const isProtectedRoute = createRouteMatcher(["/users(.*)", "/health(.*)", "/content(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
