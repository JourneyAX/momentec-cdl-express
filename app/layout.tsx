import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Upload your AI design",
  description: "Drag and drop your AI generated design and get production-ready mockups for approval within 24hrs at no charge.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
