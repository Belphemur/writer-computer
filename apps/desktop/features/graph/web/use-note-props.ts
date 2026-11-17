// Frontmatter of the notes in view, loaded only when something needs it (a `[property:value]` term
// in the search or a color rule, or Group by a frontmatter key); kept per slice epoch.
import { useEffect, useState } from "react";
import { noteFrontmatter, type GraphSlice } from "./ipc";
import type { PropsByPath } from "./model";

const NONE: PropsByPath = {};

export function useNoteProps(slice: GraphSlice | null, needed: boolean): PropsByPath {
  const [loaded, setLoaded] = useState<{ epoch: number; props: PropsByPath } | null>(null);
  const epoch = slice?.epoch ?? -1;
  useEffect(() => {
    if (!slice || !needed) return;
    let stale = false;
    const paths = slice.nodes.filter((n) => !n.unresolved).map((n) => n.path);
    noteFrontmatter(paths).then(
      (props) => {
        if (!stale) setLoaded({ epoch, props });
      },
      () => {
        if (!stale) setLoaded({ epoch, props: NONE });
      },
    );
    return () => {
      stale = true;
    };
    // The slice object changes with every refetch; its epoch plus node count identify its content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch, slice?.nodes.length, needed]);
  return needed && loaded ? loaded.props : NONE;
}
