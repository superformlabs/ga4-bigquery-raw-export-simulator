import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import KeyboardRing from "@/components/KeyboardRing";
import "./globals.css";

export const metadata: Metadata = {
  title: "GA4 BigQuery Raw Export Simulator",
  description:
    "Install a simulated Google Analytics 4 BigQuery export into your own Google Cloud project, refreshed every day.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <KeyboardRing />
      </body>
    </html>
  );
}
