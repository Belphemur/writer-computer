import { CommunityPluginsSection } from "./components/community-plugins-section";
import { CategoryBlock } from "@/components/settings-panel/settings-blocks";
import { COMMUNITY_PLUGINS_CATEGORY } from "@/components/settings-panel/settings-sections";

/** "Manage plugins": the community-plugin settings rows, then trust, the plugin list and updates. */
export function ManagePluginsPage() {
  return (
    <>
      <CategoryBlock
        block={{ type: "category", category: COMMUNITY_PLUGINS_CATEGORY }}
        hideTitle={false}
      />
      <CommunityPluginsSection />
    </>
  );
}
