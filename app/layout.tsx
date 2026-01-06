import type { Metadata } from "next";
import { Space_Grotesk } from "next/font/google";
import QueryProvider from "@/components/query-provider";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({ subsets: ["latin"], weight: ["400", "500", "600", "700"] });

export const metadata: Metadata = {
  title: "LumiCore Data Cleaner",
  description: "Normalize and validate LumiCore document data with resilience to unreliable APIs."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={spaceGrotesk.className}>
        <QueryProvider>{children}</QueryProvider>
      </body>
    </html>
  );
}
