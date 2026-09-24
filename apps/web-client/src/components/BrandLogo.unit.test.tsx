import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandLogo, isOrganizationBrand } from './BrandLogo.tsx';

const organization = {
  organizationName: 'Northwind Capital',
  accentColor: '#006b5e',
  logoUrl: null,
  squareMarkUrl: null,
  supportContact: null,
} as const;

describe('brand identity', () => {
  it('shows the Duefold mark only for the Duefold identity', () => {
    expect(renderToStaticMarkup(<BrandLogo brand={null} />)).toContain(
      'df-brand-identity__mark',
    );
  });

  it('lets an organization name replace the Duefold identity rather than sit beside its mark', () => {
    const markup = renderToStaticMarkup(<BrandLogo brand={organization} />);
    expect(markup).toContain('Northwind Capital');
    expect(markup).not.toContain('df-brand-identity__mark');
    expect(isOrganizationBrand(organization)).toBe(true);
    expect(isOrganizationBrand({ ...organization, organizationName: 'Duefold' })).toBe(false);
  });
});
