import { useActiveTab, useActiveTabId, useOpenTabs } from "@/hooks/use-tabs";
import { pageKind } from "./page-kinds";
import { pageKindView } from "./page-kinds/views";
import { PageBody } from "./page-body";
import { EditorSearchOverlay } from "./editor-search-overlay";
import { EditorNoticeBanner } from "./editor-notice-banner";
import { useEffect } from "react";
import { registerOsDropTarget, useOsDrop } from "@/lib/os-drop";
import { editorOsDropTarget } from "./editor-image-insert";

interface EditorAreaProps {
  showFooter?: boolean;
}

function EditorArea({ showFooter = true }: EditorAreaProps) {
  const activeTab = useActiveTab();
  const activeTabId = useActiveTabId();
  const tabs = useOpenTabs();
  useOsDrop();
  useEffect(() => registerOsDropTarget(editorOsDropTarget), []);

  return (
    <div className="relative h-full overflow-clip">
      <PageBody>
        {tabs.map((tab) => {
          const k = pageKind(tab.location);
          const isActive = tab.id === activeTabId;
          if (!k.keepAlive && !isActive) return null;
          const Component = pageKindView(tab.location).Component as React.ComponentType<{
            location: typeof tab.location;
            isActive: boolean;
            tabId: string;
          }>;
          return (
            <Component key={tab.id} location={tab.location} isActive={isActive} tabId={tab.id} />
          );
        })}
      </PageBody>
      {showFooter && activeTab
        ? pageKindView(activeTab.location).renderFooter?.(activeTab.location)
        : null}
      <EditorSearchOverlay />
      <EditorNoticeBanner />
    </div>
  );
}

export { EditorArea };
