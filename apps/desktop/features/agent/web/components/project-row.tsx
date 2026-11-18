import type { ReactNode } from "react";

/** The one look of a project in a list (spec 4.6): icon, name and folder. The title dropdown's
 *  options and the Projects list's rows both render it; each adds its own trailing actions. */
export function ProjectRowLabel({
  icon,
  name,
  detail,
}: {
  icon: ReactNode;
  name: string;
  detail: string;
}) {
  return (
    <>
      <span className="self-center">{icon}</span>
      <span className="truncate text-[var(--text-primary)]">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text-muted)]">{detail}</span>
    </>
  );
}
