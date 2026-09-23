import type { Metadata } from "next";
import { Geist, Geist_Mono, Lora } from "next/font/google";
import "./globals.css";
import { EngineProvider } from "@/lib/engine-store";
import { Shell } from "@/components/shell";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
const lora = Lora({ variable: "--font-lora", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "syrup",
  description: "A self-hosted coding agent powered by your own API keys.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${lora.variable} h-full antialiased`}>
      <body className="h-full">
        <EngineProvider>
          <Shell>{children}</Shell>
        </EngineProvider>
      </body>
    </html>
  );
}
