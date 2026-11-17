/** Placeholder for a view type nothing registered (kanban, map, unknown): the YAML stays untouched. */
export function UnsupportedView({ type, onEditYaml }: { type: string; onEditYaml: () => void }) {
  return (
    <div
      role="status"
      data-base-unsupported={type}
      className="flex flex-col items-start gap-2 px-4 py-6 text-[13px] text-text-secondary"
    >
      <div className="font-medium text-text-primary">
        The &ldquo;{type}&rdquo; view type is not available in Writer.
      </div>
      <div>
        Its settings stay in the file exactly as they are. Other views of this base still work, and
        you can edit the file by hand.
      </div>
      <button
        type="button"
        onClick={onEditYaml}
        className="cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1 text-[12px] text-text-primary hover:bg-[var(--item-hover-bg)]"
      >
        Edit YAML
      </button>
    </div>
  );
}
