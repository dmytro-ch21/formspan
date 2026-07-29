import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { Barlow, Barlow_Condensed } from "next/font/google";
import "./globals.css";

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
    <ClerkProvider>
      <html lang="en" className={`${barlow.variable} ${barlowCondensed.variable}`}>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
