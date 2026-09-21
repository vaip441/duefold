/**
 * Branding browser contribution tests.
 *
 * The property under test is the one invariant 17 rests on: this module contributes
 * its section rather than the application declaring it, so omitting the module removes
 * the tab, its label, and the panel instead of shipping them inert.
 *
 * The bundle-level proof — that none of it reaches a minimal build — is in
 * `test/browser/composition.spec.ts`, because only a real build can show absence.
 * What is asserted here is the contract that makes that absence possible.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { contribution } from './branding-section.tsx';
import { brandingCopy } from './copy.ts';
import { BrandingPanel } from './BrandingPanel.tsx';

describe('section contribution', () => {
  it('contributes exactly one room section', () => {
    const sections = contribution.sections ?? [];
    expect(sections).toHaveLength(1);
    expect(sections[0]?.id).toBe('branding');
    expect(sections[0]?.scope).toBe('room');
  });

  it('sorts after the four core room sections', () => {
    // Core occupies 10 through 40, so 50 places Branding last without the
    // application naming it.
    expect(contribution.sections?.[0]?.order).toBe(50);
  });

  it('resolves its own label, so the copy leaves with the module', () => {
    /*
     * A key into the application's catalogue would leave "Branding" in a minimal
     * bundle: composition state disclosed as product copy, with the tab's absence
     * resting on whatever code happened not to read the key.
     */
    expect(contribution.sections?.[0]?.label()).toBe(brandingCopy('section.tab'));
    expect(contribution.sections?.[0]?.label()).toBe('Branding');
  });
});

describe('panel copy', () => {
  /*
   * Rendered directly rather than through the contribution, whose component mounts a
   * loader that needs a DOM and a server. The panel's designed states are what matter
   * here.
   */
  function render(overrides: Partial<Parameters<typeof BrandingPanel>[0]> = {}): string {
    return renderToStaticMarkup(
      <BrandingPanel
        configuration={null}
        loading={false}
        denied={false}
        failure={null}
        savePending={false}
        onSave={() => undefined}
        onUploadAsset={() => Promise.resolve()}
        onDeleteAsset={() => Promise.resolve()}
        onReload={() => undefined}
        {...overrides}
      />,
    );
  }

  it('states that custom styles, fonts, and scripts are not accepted', () => {
    // So a member does not go looking for a theme editor that deliberately does not
    // exist.
    expect(render()).toContain(brandingCopy('note'));
  });

  it('reports a refusal as terminal rather than as still loading', () => {
    /*
     * `configuration === null` after a refusal once left this section claiming it was
     * loading underneath the error notice, so the operator saw a contradiction and no
     * resolution.
     */
    const markup = render({
      denied: true,
      failure: {
        kind: 'denied',
        title: 'Not available to you',
        body: 'no',
        offerReload: false,
      },
    });
    expect(markup).not.toContain(brandingCopy('loading'));
    expect(markup).toContain('role="alert"');
  });

  it('renders the loading line while the configuration is unread', () => {
    expect(render({ loading: true })).toContain(brandingCopy('loading'));
  });
});
