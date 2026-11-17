// Palette entries contributed by features. The palette (`components/command-palette/commands.ts`)
// resolves these next to its built-ins with the same availability, action and shortcut rules, so a
// feature command is data like any other (docs/consolidation.md: registry over per-case branches).
import type { CommandContext } from "@/components/command-palette/commands";
import { OwnedRegistry } from "@/lib/owned-registry";

export interface FeaturePaletteCommand {
  owner: string;
  id: string;
  label: string;
  description: string;
  when?: (ctx: CommandContext) => boolean;
  keepOpen?: boolean;
  run: (ctx: CommandContext) => void;
}

export const featurePaletteCommands = new OwnedRegistry<FeaturePaletteCommand>();

/** Commands a feature computes each time the palette opens (the Obsidian host's plugin commands,
 *  whose availability runs plugin code). Core lists them after the built-ins and never lets one
 *  take a built-in's id. */
export interface PaletteCommandSource {
  owner: string;
  /** `<feature id>.<name>`. */
  id: string;
  list: (ctx: CommandContext) => readonly Omit<FeaturePaletteCommand, "owner">[];
}

export const featurePaletteSources = new OwnedRegistry<PaletteCommandSource>();
