import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "./nav";
import { THEMES, THEME_STORAGE_KEY } from "@/lib/themes";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "JLPT Hub",
  description: "JLPT N5/N4 study schedule and sentence workshop.",
};

const APPEARANCES = Object.fromEntries(
  THEMES.map((t) => [t.id, t.appearance]),
);

// Applies the stored theme before first paint (docs: preventing-flash-before-hydration).
// An unknown or "system" preference resolves to light/dark from the OS setting.
const themeInitScript = `(function(){try{var a=${JSON.stringify(APPEARANCES)};var t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(!t||!a[t])t=window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";var e=document.documentElement;e.setAttribute("data-theme",t);e.setAttribute("data-appearance",a[t])}catch(e){}})()`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-theme="light"
      data-appearance="light"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-background text-foreground">
        <Nav />
        <main className="flex-1">{children}</main>
      </body>
    </html>
  );
}
