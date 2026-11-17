import {
  activateLink,
  openExternal,
  wikiLinkTarget,
  type LinkIntent,
  type WikiLinkReport,
} from "@/lib/link-activation";
import { wikiLinkInner } from "@/lib/wiki-links";
import { showEditorNotice } from "./editor-notice-store";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

const report: WikiLinkReport = (problem, target, error) => {
  if (problem === "no-workspace") showEditorNotice("No workspace is open");
  else if (problem === "unresolved") showEditorNotice(`"${target}" was not found in the vault`);
  else showEditorNotice(`Could not open "${target}": ${message(error)}`);
};

/** Open a `[[wikilink]]` property value for a gesture (`lib/link-activation.ts`); report what
 *  could not be resolved. A value has no source note: it resolves vault-wide. */
export function openPropertyWikilink(value: string, intent: LinkIntent): void {
  activateLink(
    wikiLinkTarget(wikiLinkInner(value), () => null, undefined, report),
    intent,
  );
}

export async function openPropertyUrl(url: string): Promise<void> {
  try {
    await openExternal(url);
  } catch (e) {
    showEditorNotice(`Could not open the link: ${message(e)}`);
  }
}
