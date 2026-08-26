import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Redrive — Control plane",
  description: "A control plane for deliberate webhook recovery.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
