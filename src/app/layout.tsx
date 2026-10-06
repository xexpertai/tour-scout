import type { Metadata, Viewport } from "next";
import { Anton, Barlow, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Anton({ variable: "--font-anton", weight: "400", subsets: ["latin"] });
// Barlow: a plain grotesk with a poster feel; mono is kept for Q-ids and request listings only.
const sans = Barlow({ variable: "--font-inter", weight: ["400", "500", "600", "700"], subsets: ["latin"] });
const mono = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Tour Scout",
  description: "Find your fans before you book the room. Tour Scout reads Qloo's taste graph to plan stops, venues, openers and the pitch.",
};

export const viewport: Viewport = { themeColor: "#0B0B0F" };

// Applies a saved theme choice before paint so the page never flashes the other theme.
const themeScript = `try{var t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
