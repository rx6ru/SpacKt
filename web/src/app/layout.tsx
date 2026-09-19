import type { ReactNode } from "react";
import type { Metadata, Viewport } from "next";
import { geistMono, geistSans } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "SpacKt | Simulated BTC-USD market",
  description: "Explore a simulated crypto market with live candles, an order book, and adaptive delivery.",
};

export const viewport: Viewport = { themeColor: "#0b0d10" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
