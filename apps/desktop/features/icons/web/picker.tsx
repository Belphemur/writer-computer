import { useState } from "react";
import { IconPicker } from "@/components/icon-picker/icon-picker";
import { ModalShell } from "@/components/modal-shell";
import { useFileIcon } from "@/lib/file-icons";
import { iconsRemove, iconsSet } from "./ipc";
import { useIconPickerStore } from "./picker-store";
import { syncIcons } from "./sync";

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong.";
}

/**
 * "Change icon...": the core icon picker (Icons, Emoji, Remove icon) in a modal, for one path or a
 * multi-selection. It only reports choices; the write is `icons_set` / `icons_remove` (Rust owns
 * `.writer/icons.json`), then the one store is reloaded. Rendered once from the picker store.
 */
export default function IconPickerOverlay() {
  const paths = useIconPickerStore((s) => s.paths);
  const close = useIconPickerStore((s) => s.close);
  if (!paths) return null;
  return <PickerBody key={paths.join("\0")} paths={paths} onClose={close} />;
}

function PickerBody({ paths, onClose }: { paths: readonly string[]; onClose: () => void }) {
  // The current icon is only meaningful for one path; a multi-selection starts empty.
  const current = useFileIcon(paths.length === 1 ? paths[0] : null);
  const [error, setError] = useState<string | null>(null);

  async function run(write: () => Promise<void>) {
    try {
      await write();
      await syncIcons();
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  }

  return (
    <ModalShell
      onClose={onClose}
      labelledBy="icons-picker-title"
      className="rounded-lg shadow-lg"
      initialFocus={false}
    >
      <h2 id="icons-picker-title" className="sr-only">
        Change icon
      </h2>
      <IconPicker
        label="Change icon"
        value={current?.icon ?? null}
        error={error}
        onClose={onClose}
        onPick={(value) => void run(() => iconsSet([...paths], value, current?.color))}
        onRemove={current ? () => void run(() => iconsRemove([...paths])) : undefined}
      />
    </ModalShell>
  );
}
