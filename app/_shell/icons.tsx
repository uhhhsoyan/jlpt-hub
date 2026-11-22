import type { ReactNode } from "react";
import type { NavIconName } from "@/lib/nav";

/**
 * Small inline line icons for the app shell: one 24-unit grid, one stroke weight, drawn in
 * currentColor so they follow the theme. Decorative: the label beside (or the aria-label on
 * the control around) each icon carries the meaning.
 */
function Svg({ children, className = "size-[18px]" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={`shrink-0 ${className}`}
    >
      {children}
    </svg>
  );
}

const NAV_PATHS: Record<NavIconName, ReactNode> = {
  journal: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="2" />
      <path d="M9 3v18M12.5 8H16M12.5 12H16" />
    </>
  ),
  insights: (
    <>
      <path d="M9 18h6M10 21h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.3 1.1 2.2h5c0-.9.5-1.7 1.1-2.2A6 6 0 0 0 12 3Z" />
    </>
  ),
  practice: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="3" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  queue: (
    <>
      <path d="M12 4 3.5 8.5 12 13l8.5-4.5L12 4Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
    </>
  ),
  progress: <path d="M4 20h16M7 16v-4M12 16V7M17 16v-7" />,
  sprint: <path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z" />,
  library: (
    <>
      <rect x="3.5" y="4" width="4" height="16" rx="1" />
      <rect x="9.5" y="4" width="4" height="16" rx="1" />
      <path d="m15.6 5.4 3-.8 3.4 14.2-3 .8-3.4-14.2Z" />
    </>
  ),
  workshop: (
    <>
      <path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z" />
      <path d="m14 7 3 3" />
    </>
  ),
  mine: (
    <>
      <path d="M4 15v-3a8 8 0 0 1 16 0v3" />
      <rect x="3" y="14" width="4" height="6" rx="1.5" />
      <rect x="17" y="14" width="4" height="6" rx="1.5" />
    </>
  ),
  schedule: (
    <>
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 10h16M9 3v4M15 3v4" />
    </>
  ),
  sources: <path d="M7 3h10a1 1 0 0 1 1 1v17l-6-4-6 4V4a1 1 0 0 1 1-1Z" />,
};

export function NavIcon({ name }: { name: NavIconName }) {
  return <Svg>{NAV_PATHS[name]}</Svg>;
}

export function MenuIcon() {
  return (
    <Svg className="size-5">
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function CloseIcon() {
  return (
    <Svg className="size-5">
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  );
}

/** Sidebar panel with a chevron pointing the way the toggle will move it. */
export function SidebarToggleIcon({ collapsed }: { collapsed: boolean }) {
  return (
    <Svg>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
      <path d={collapsed ? "m13.5 10 2 2-2 2" : "m16 10-2 2 2 2"} />
    </Svg>
  );
}

export function FlagIcon() {
  return (
    <Svg>
      <path d="M5 21V4M5 4h11l-2 4 2 4H5" />
    </Svg>
  );
}
