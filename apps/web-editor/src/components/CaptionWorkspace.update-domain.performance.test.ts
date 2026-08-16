import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

function workspaceSource(): string {
  const candidates = [
    path.resolve(process.cwd(), 'src/components/CaptionWorkspace.tsx'),
    path.resolve(process.cwd(), 'apps/web-editor/src/components/CaptionWorkspace.tsx'),
  ];
  const file = candidates.find(existsSync);
  if (!file) throw new Error('Could not locate CaptionWorkspace.tsx.');
  return readFileSync(file, 'utf8');
}

describe('CaptionWorkspace update-domain boundaries', () => {
  it('keeps expensive template preview leaves memoized away from cue edits', () => {
    const source = workspaceSource();
    expect(source).toContain('const CaptionTemplateTile = memo(');
    expect(source).toContain('const templates = useMemo(() =>');
    expect(source).toContain('const deferredQuery = useDeferredValue(query);');
  });

  it('bounds long caption projects to a virtualized cue viewport', () => {
    const source = workspaceSource();
    expect(source).toContain('useVirtualizer');
    expect(source).toContain('const CUE_LIST_OVERSCAN = 8;');
    expect(source).toContain('getVirtualItems()');
  });

  it('runs template animation only for active visible previews', () => {
    const source = workspaceSource();
    expect(source).toContain('const time = useGalleryClock(active && onScreen);');
    expect(source).toContain('const galleryOnScreen = useOnScreen(galleryRef);');
  });
});
