import type { ComponentType } from "react";
import { useAllSettings, useResetSetting, useSetSetting } from "@/hooks/use-settings";
import { SETTINGS_SCHEMA, type SettingDef } from "@/lib/settings-schema";
import { CommunityPluginsSection } from "@/components/plugins/community-plugins-section";
import type { SectionBlock, SettingsSection } from "./settings-sections";
import { SettingControl } from "./setting-control";
import { LogsSection } from "./logs-section";
import { SecretsSection } from "./secrets-section";
import { ThemesSection } from "./themes-section";

type BlockOf<T extends SectionBlock["type"]> = Extract<SectionBlock, { type: T }>;

function CategoryBlock({ block, hideTitle }: { block: BlockOf<"category">; hideTitle: boolean }) {
  const settings = useAllSettings();
  const setSetting = useSetSetting();
  const resetSetting = useResetSetting();
  const defs = SETTINGS_SCHEMA.filter((def) => def.category === block.category);
  if (defs.length === 0) return null;

  function isModified(def: SettingDef): boolean {
    return JSON.stringify(settings[def.key]) !== JSON.stringify(def.default);
  }

  return (
    <section className="mb-10" data-settings-category={block.category}>
      {!hideTitle && (
        <h2 className="mb-3 text-[13px] font-medium text-[var(--text-muted)]">{block.category}</h2>
      )}
      <div className="overflow-hidden rounded-2xl border border-[var(--line-subtler)] bg-[var(--surface-card)]">
        {defs.map((def, i) => (
          <div
            key={def.key}
            className={i === 0 ? undefined : "border-t border-[var(--line-subtler)]"}
          >
            <SettingControl
              def={def}
              value={settings[def.key]}
              onChange={(value) => setSetting(def.key, value)}
              onReset={() => void resetSetting(def.key)}
              isModified={isModified(def)}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** One renderer per block type; keyed by the union so a new type must be added here. */
const BLOCK_RENDERERS: {
  [T in SectionBlock["type"]]: ComponentType<{ block: BlockOf<T>; hideTitle: boolean }>;
} = {
  category: CategoryBlock,
  themes: () => <ThemesSection />,
  "community-plugins": () => <CommunityPluginsSection />,
  secrets: () => <SecretsSection />,
  logs: () => <LogsSection />,
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
