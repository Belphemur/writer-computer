import type { ComponentType } from "react";
import { appliesHere, SETTINGS_SCHEMA } from "@/lib/settings-schema";
import type { SectionBlock, SettingsSection } from "./settings-sections";
import { SettingRows } from "./setting-rows";
import { CliSection } from "./cli-section";
import { FeaturesSection } from "./features-section";
import { LogsSection } from "./logs-section";
import { SecretsSection } from "./secrets-section";
import { ThemesSection } from "./themes-section";

type BlockOf<T extends SectionBlock["type"]> = Extract<SectionBlock, { type: T }>;

export function CategoryBlock({
  block,
  hideTitle,
}: {
  block: BlockOf<"category">;
  hideTitle: boolean;
}) {
  const defs = SETTINGS_SCHEMA.filter((def) => def.category === block.category && appliesHere(def));
  if (defs.length === 0) return null;
  return (
    <section className="mb-10" data-settings-category={block.category}>
      {!hideTitle && (
        <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">{block.category}</h2>
      )}
      <SettingRows defs={defs} />
    </section>
  );
}

/** One renderer per block type; keyed by the union so a new type must be added here. */
const BLOCK_RENDERERS: {
  [T in SectionBlock["type"]]: ComponentType<{ block: BlockOf<T>; hideTitle: boolean }>;
} = {
  category: CategoryBlock,
  themes: () => <ThemesSection />,
  secrets: () => <SecretsSection />,
  cli: () => <CliSection />,
  logs: () => <LogsSection />,
  features: () => <FeaturesSection />,
};

export function SectionBlocks({ section }: { section: SettingsSection }) {
  return (
    <>
      {section.blocks.map((block) => {
        const Renderer = BLOCK_RENDERERS[block.type] as ComponentType<{
          block: SectionBlock;
          hideTitle: boolean;
        }>;
        const key = block.type === "category" ? `category:${block.category}` : block.type;
        return (
          <Renderer
            key={key}
            block={block}
            hideTitle={block.type === "category" && block.category === section.label}
          />
        );
      })}
    </>
  );
}
