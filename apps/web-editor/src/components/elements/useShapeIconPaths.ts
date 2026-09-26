/**
 * The Lucide icon outlines for Shapes-tab tiles (plan/elements EL5.5), loaded once, on first use.
 *
 * The outlines are ~0.7 MB of path data, so they are a separate chunk the editor fetches only
 * when a tile needs an icon; the engine has its own packaged copy and never waits on this.
 */
import { useEffect, useState } from 'react';

type IconDocument = { readonly icons: readonly { readonly id: string; readonly path: string }[] };

let loading: Promise<ReadonlyMap<string, string>> | undefined;
let loaded: ReadonlyMap<string, string> | null = null;

/** Every icon's outline by name (`check`, not `icon/check`), fetched at most once. */
export function loadShapeIconPaths(): Promise<ReadonlyMap<string, string>> {
  loading ??= import('@framepilot/timeline-schema/shape-icons.json').then((module) => {
    const document = module.default as IconDocument;
    loaded = new Map(document.icons.map((icon) => [icon.id.slice('icon/'.length), icon.path]));
    return loaded;
  });
  return loading;
}

/** The icon outlines once loaded, `null` until then; asks for them when `wanted`. */
export function useShapeIconPaths(wanted = true): ReadonlyMap<string, string> | null {
  const [paths, setPaths] = useState(loaded);
  useEffect(() => {
    if (!wanted || paths !== null) return;
    let live = true;
    void loadShapeIconPaths().then((map) => {
      if (live) setPaths(map);
    });
    return () => {
      live = false;
    };
  }, [wanted, paths]);
  return paths;
}
