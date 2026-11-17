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
