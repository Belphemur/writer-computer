// Settings > Icons: what the icons feature shows of Iconize's data. The switch itself is on the
// Features page; nothing here is configurable, so the page is one line.
import { useIconizeStatus } from "./sync";

export function IconsSection() {
  const unsupported = useIconizeStatus((s) => s.unsupported);
  return (
    <section data-icons-settings className="mb-10">
      <p className="px-1 text-[13px] text-[var(--text-muted)]">
        {unsupported === 0
          ? "Iconize icons show as they are."
          : `${unsupported} Iconize ${unsupported === 1 ? "icon uses a pack" : "icons use packs"} Writer does not show.`}
      </p>
    </section>
  );
}
