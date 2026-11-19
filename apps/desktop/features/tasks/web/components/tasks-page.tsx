// The Tasks page: the built-in sections (each a `rows: tasks` base, drawn by the Bases view
// through the `bases.views` service) and the quick add. One scroller, its root.
import { useEffect, useState, type ComponentType } from "react";
import { getService } from "@/lib/features/services";
import { getWorkspaceRoot } from "@/hooks/workspace-api";
import { logger } from "@/lib/logger";
import type { BasesViewsService, EmbeddedBaseProps } from "@features/bases/web/api";
import { tasksSections, type TaskSection } from "../ipc";
import { openQuickAdd } from "../actions";

const BASES_VIEWS = "bases.views";
const noop = () => {};

function useSections(): TaskSection[] | null {
  const [sections, setSections] = useState<TaskSection[] | null>(null);
  useEffect(() => {
    let current = true;
    tasksSections().then(
      (s) => current && setSections(s),
      (e) => logger.warn("app", `could not load the task sections: ${String(e)}`),
    );
    return () => {
      current = false;
    };
  }, []);
  return sections;
}

function useTextEmbed(): ComponentType<EmbeddedBaseProps> | null | undefined {
  // `undefined`: loading; `null`: the Bases feature is off
  const [embed, setEmbed] = useState<ComponentType<EmbeddedBaseProps> | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let current = true;
    const service = getService<BasesViewsService>(BASES_VIEWS);
    if (!service) {
      setEmbed(null);
      return;
    }
    service.loadEmbeddedBase().then(
      (c) => current && setEmbed(() => c),
      (e) => {
        logger.warn("app", `could not load the base view: ${String(e)}`);
        if (current) setEmbed(null);
      },
    );
    return () => {
      current = false;
    };
  }, []);
  return embed;
}

export function TasksPage() {
  const sections = useSections();
  const Embed = useTextEmbed();
  const root = getWorkspaceRoot() ?? "";
  // `this` inside a section: the vault itself (the sections do not use it)
  const notePath = `${root.replace(/[\\/]+$/, "")}/Tasks.md`;
  return (
    <div data-testid="tasks-page" className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[880px] flex-col gap-6 px-6 py-8">
        <header className="flex items-center justify-between">
          <h1 className="text-[20px] font-semibold text-[var(--text-primary)]">Tasks</h1>
          <button
            type="button"
            onClick={openQuickAdd}
            className="rounded-md border border-[var(--line-subtle)] px-3 py-1.5 text-[13px] text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]"
          >
            Add task
          </button>
        </header>
        {Embed === null ? (
          <p className="text-[13px] text-[var(--text-muted)]">Bases is turned off.</p>
        ) : Embed && sections ? (
          sections.map((s) => (
            <section key={s.id} aria-label={s.label} className="flex flex-col gap-2">
              <h2 className="text-[13px] font-semibold text-[var(--text-muted)]">{s.label}</h2>
              <Embed embed={{ kind: "block", text: s.base }} notePath={notePath} onEdit={noop} />
            </section>
          ))
        ) : null}
      </div>
    </div>
  );
}
