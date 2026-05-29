import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Spend Profile Agent",
  description: "10-K → procurement spend profile for sales discovery.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-950 text-neutral-100 antialiased">{children}</body>
    </html>
  );
}
