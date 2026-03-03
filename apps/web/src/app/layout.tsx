import type { Metadata } from "next";
import { Providers } from "./Providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "OI - Your AI Companion",
  description: "An interactive AI agent that automates tasks through natural conversation",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white text-neutral-900">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
