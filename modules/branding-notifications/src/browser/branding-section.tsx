/**
 * The organization Branding section, under Administration.
 *
 * Contributed, not hardcoded, so an installation that omits this module ships
 * neither the tab, its label, nor the panel. The label resolves through this
 * module's own catalogue for the same reason.
 *
 * Branding is installation-wide, so it is a top-level section rather than a room
 * one: showing it inside every room implied a per-room setting that does not exist.
 */

import { createElement, useEffect } from 'react';
import type { BrowserContribution, TopSectionProps } from '@duefold/web-client/module-api';
import { BrandingPanel } from './BrandingPanel.tsx';
import { brandingCopy } from './copy.ts';
import { useBrandingSection } from './useBrandingSection.ts';

function BrandingSection({ onStatus }: TopSectionProps): React.ReactElement {
  const section = useBrandingSection({
    onSaved: () => {
      onStatus(brandingCopy('saved'));
    },
  });
  const { refresh } = section;
  useEffect(() => {
    refresh();
  }, [refresh]);
  return (
    <BrandingPanel
      configuration={section.configuration}
      loading={section.loading}
      denied={section.denied}
      failure={section.failure}
      savePending={section.saving}
      onSave={section.save}
      onUploadAsset={async (kind, file) => {
        await section.uploadAsset(kind, file);
        refresh();
      }}
      onDeleteAsset={async (kind) => {
        await section.deleteAsset(kind);
        refresh();
      }}
      onReload={refresh}
    />
  );
}

export const contribution: BrowserContribution = {
  sections: [
    {
      id: 'branding',
      scope: 'top',
      label: () => brandingCopy('section.tab'),
      order: 25,
      render: (props) => createElement(BrandingSection, props),
    },
  ],
};
