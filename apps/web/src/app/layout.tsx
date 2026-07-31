import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { clerkAppearance, clerkLocalization } from "./clerkAppearance";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";
import { ThemeScript } from "./ThemeToggle";

// Barlow for text, Barlow Condensed for numerals and micro-labels — the
// same pair the admin console uses, so the two surfaces read as one product.
const barlow = Barlow({
  variable: "--font-barlow",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

const barlowCondensed = Barlow_Condensed({
  variable: "--font-barlow-condensed",
  subsets: ["latin"],
  weight: ["500", "600", "700"],
});

export const metadata: Metadata = {
  title: "VOLA",
  description: "VOLA web app",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider appearance={clerkAppearance} localization={clerkLocalization}>
      {/*
        suppressHydrationWarning is load-bearing, not a silencer.

        ThemeScript runs in <head> and sets `data-theme` on this element
        before React hydrates — that's the whole point of it, and it's what
        stops a dark-mode user seeing a white flash on every navigation. So
        the server HTML legitimately lacks an attribute the live DOM has, and
        React reports it as a mismatch on every page load.

        This is the case the prop exists for. It applies to *this element's
        own attributes only*, one level deep, so a real mismatch anywhere in
        the tree below is still reported.
      */}
      <html
        lang="en"
        suppressHydrationWarning
        className={`${barlow.variable} ${barlowCondensed.variable}`}
      >
        <head>
          <ThemeScript />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
