/**
 * Contract between the browser application and module browser entries.
 *
 * A module's browser entry exports `contribution`. The build-time plugin in
 * `vite.config.ts` reads the generated registry and emits literal static imports
 * of exactly the composed modules' entries. There is no runtime discovery, no
 * dynamic import of module code, and no feature flag: an omitted module is never
 * named by any import, so its code cannot reach the bundle.
 */

export interface SupportContact {
  readonly kind: 'email' | 'url';
  readonly value: string;
}

export interface SupportContactSlot {
  /** Resolves `null` for unconfigured, unavailable, or failed — indistinguishably. */
  load(signal: AbortSignal): Promise<SupportContact | null>;
}

export interface EffectiveBrand {
  readonly organizationName: string;
  readonly accentColor: string;
  readonly logoUrl: string | null;
  readonly squareMarkUrl: string | null;
  readonly supportContact: SupportContact | null;
}

export interface BrandingSlot {
  /** Resolves null when unconfigured, unavailable, or failed — indistinguishably. */
  load(signal: AbortSignal): Promise<EffectiveBrand | null>;
}

export interface ViewerIntroductionSlot {
  /** Rejects when the protected projection cannot be loaded or parsed. */
  load(signal: AbortSignal): Promise<string>;
}

export interface BrowserContribution {
  readonly supportContact?: SupportContactSlot;
  readonly branding?: BrandingSlot;
  readonly viewerIntroduction?: ViewerIntroductionSlot;
}
