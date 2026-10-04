import type { CSSProperties } from "react";

/** Small, consistent line icons. Labels belong to the surrounding control. */
export function Icon({
  name,
  size = 20,
}: {
  name: "branch" | "dashboard" | "settings" | "terminal" | "inbox";
  size?: number;
}) {
  const paths = {
    branch: (
      <>
        <circle cx="6" cy="5" r="2" />
        <circle cx="6" cy="19" r="2" />
        <circle cx="18" cy="5" r="2" />
        <path d="M6 7v10M18 7v2a5 5 0 0 1-5 5H6" />
      </>
    ),
    dashboard: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </>
    ),
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" fill="var(--icon-fill, currentColor)" />
        <circle cx="15" cy="17" r="3" fill="var(--icon-fill, currentColor)" />
      </>
    ),
    terminal: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3m6 0h4" />
      </>
    ),
    inbox: (
      <>
        <path d="m4 5-2 9v5h20v-5l-2-9ZM2 14h6l2 3h4l2-3h6" />
        <path d="M8 8h8" />
      </>
    ),
  };
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 } as CSSProperties}
    >
      {paths[name]}
    </svg>
  );
}
