/**
 * The room Branding section.
 *
 * Contributed, not hardcoded. Section navigation used to be a literal array in
 * the application, so an installation that omitted this module still shipped the
 * Branding tab, its label, and the panel in the browser bundle. That contradicted
 * the invariant that an omitted module is ABSENT from production artifacts rather
 * than hidden by a runtime check. With the tab contributed, the generated registry
 * has no entry, nothing imports this file, and neither the tab nor the panel can
 * reach the bundle.
 *
 * The label resolves through this module's own catalogue for the same reason: a
 * key in the application's catalogue would leave "Branding" in a minimal build.
 */

import { createElement, useEffect } from 'react';
import type { BrowserContribution, SectionProps } from '@duefold/web-client/contract';
import { BrandingPanel } from './BrandingPanel.tsx';
import { brandingCopy } from './copy.ts';
import { useBrandingSection } from './useBrandingSection.ts';

/**
 * The section's own component, so its state machine mounts with the section and
 * unmounts with it. The application does not hold branding state on its behalf.
 */
function BrandingSection({ roomId, onStatus }: SectionProps): React.ReactElement {
  const section = useBrandingSection({
    onSaved: () => {
      onStatus(brandingCopy('saved'));
    },
  });
  const { refresh } = section;
  /*
   * Loaded on mount rather than on room open. The frame mounts a section when it
   * becomes current, so this is the same "fetch when first shown" the application
   * had: a Manager who never opens Branding causes no branding request.
   */
  useEffect(() => {
    if (roomId !== null) refresh(roomId);
  }, [roomId, refresh]);
  /*
   * `scope: 'room'` means the frame renders this only inside a room, so a null id
   * is unreachable. It is still handled rather than asserted away: a crash on a
   * contract violation would take the whole worktable down.
   */
  if (roomId === null) return createElement('p', { className: 'df-field__help' }, null);
  return (
    <BrandingPanel
      configuration={section.configuration}
      loading={section.loading}
      denied={section.denied}
      failure={section.failure}
      savePending={section.saving}
      onSave={(input) => {
        section.save({ roomId, ...input });
      }}
      onUploadAsset={async (kind, file) => {
        await section.uploadAsset(kind, file);
        section.refresh(roomId);
      }}
      onDeleteAsset={async (kind) => {
        await section.deleteAsset(roomId, kind);
        section.refresh(roomId);
      }}
      onReload={() => {
        section.refresh(roomId);
      }}
    />
  );
}

export const contribution: BrowserContribution = {
  sections: [
    {
      id: 'branding',
      scope: 'room',
      label: () => brandingCopy('section.tab'),
      /* After the four core room sections, which occupy 10 through 40. */
      order: 50,
      render: (props) => createElement(BrandingSection, props),
    },
  ],
};
