import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { cookies } from "next/headers";
import "./globals.css";
import { AppShell } from "./_shell/app-shell";
import { SIDEBAR_COOKIE, isSidebarCollapsed } from "@/lib/nav";
import { EXAM_DATE_ISO } from "@/lib/readiness";
import { dayDiff, feedDay } from "@/lib/study-feed";
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Read on the server so the first HTML already has the sidebar at its stored width: no
  // flash, and no hydration mismatch on the toggle. Every route is dynamic already, so the
  // cookie read doesn't cost a static page. Never touches the database.
  const collapsed = isSidebarCollapsed((await cookies()).get(SIDEBAR_COOKIE)?.value);
  // Same calendar day the journal uses (learner's zone). The layout persists across client
  // navigations, so this refreshes on a full load.
  const daysToExam = dayDiff(feedDay(new Date()), EXAM_DATE_ISO);

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
        <a
          href="#main"
          className="sr-only rounded-lg bg-surface px-3 py-2 text-sm font-semibold text-foreground shadow-lg ring-2 ring-accent focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[60]"
        >
          Skip to content
        </a>
        <AppShell initialCollapsed={collapsed} daysToExam={daysToExam}>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
