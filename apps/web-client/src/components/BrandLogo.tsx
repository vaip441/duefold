import { RIBBON_BOWL_PATH, RIBBON_STEM_PATH } from '@duefold/shared/brand-mark';
import type { ReactElement } from 'react';
import type { EffectiveBrand } from '../contract.ts';
import { useBrand } from '../branding/useBrand.ts';
import { translate } from '../i18n/translate.ts';

export interface BrandLogoProps {
  readonly className?: string;
  readonly brand?: EffectiveBrand | null;
}

function BrandIdentity({
  className,
  brand,
}: {
  readonly className: string | undefined;
  readonly brand: EffectiveBrand | null;
}): ReactElement {
  if (brand?.logoUrl) {
    return (
      <span className={`df-brand-identity ${className ?? ''}`.trim()}>
        <img
          src={brand.logoUrl}
          alt={brand.organizationName}
          className="df-brand-identity__custom-logo"
        />
      </span>
    );
  }

  const name = brand?.organizationName ?? translate('app.name');

  return (
    <span className={`df-brand-identity ${className ?? ''}`.trim()}>
      <svg
        className="df-brand-identity__mark"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
        focusable="false"
      >
        <path d={RIBBON_STEM_PATH} fill="currentColor" />
        <path d={RIBBON_BOWL_PATH} fill="var(--accent)" />
      </svg>
      <span className="df-facts__wordmark">{name}</span>
    </span>
  );
}

/**
 * The standard Duefold identity component. The inner renderer accepts an
 * already-loaded brand so callers never trigger a second public request.
 */
export function BrandLogo({ className, brand: brandProp }: BrandLogoProps): ReactElement {
  if (brandProp !== undefined) return <BrandIdentity className={className} brand={brandProp} />;
  return <ContextBrandLogo className={className} />;
}

function ContextBrandLogo({
  className,
}: {
  readonly className: string | undefined;
}): ReactElement {
  const { brand } = useBrand();
  return <BrandIdentity className={className} brand={brand} />;
}
