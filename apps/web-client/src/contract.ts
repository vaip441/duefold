/**
 * Contract between the browser application and module browser entries.
 *
 * A module's browser entry exports `contribution`. The build-time plugin in
 * `vite.config.ts` reads the generated registry and emits literal static imports
 * of exactly the composed modules' entries. There is no runtime discovery, no
 * dynamic import of module code, and no feature flag: an omitted module is never
 * named by any import, so its code cannot reach the bundle.
 */

import type { ReactElement } from 'react';

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
  /** Set by an administrator when the logo is a wordmark that already carries the name. */
  readonly logoIncludesName: boolean;
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

/**
 * What every contributed section receives, whatever its scope.
 *
 * Deliberately narrow. A section needing the room's working entries, its revisions, or
 * another section's loader would be core navigation wearing a contribution's clothes.
 *
 * `roomId` is NOT here: whether a section has one is exactly what `scope` decides. One
 * props type carrying `string | null` forced every room section to handle a null it could
 * never receive, and the branding section's branch rendered an empty paragraph for a case
 * the frame cannot produce.
 */
export interface SectionPropsBase {
  /** Announces through the frame's single polite live region. */
  readonly onStatus: (message: string) => void;
}

/** A top-level section. There is no open room, so there is no room id to give it. */
export interface TopSectionProps extends SectionPropsBase {
  readonly scope: 'top';
}

/** A section inside a room. The frame renders it only there, so the id is present. */
export interface RoomSectionProps extends SectionPropsBase {
  readonly scope: 'room';
  readonly roomId: string;
}

export type SectionProps = TopSectionProps | RoomSectionProps;

/**
 * A section tab, whoever owns it.
 *
 * Navigation and rendering are separate on purpose. A core section renders from
 * the frame's own state, so it contributes a tab and nothing else; a module cannot
 * reach that state and contributes a tab together with the panel behind it. One
 * type carrying an unused `render` for core would be a field that exists only to
 * satisfy the type, and the first reader would wonder what it did.
 */
export interface SectionTab {
  /** Stable identifier. A contribution must not collide with a core section. */
  readonly id: string;
  readonly scope: 'top' | 'room';
  readonly label: () => string;
  /** Ascending. Core sections occupy 10, 20, 30…; a contribution sorts between. */
  readonly order: number;
}

/**
 * A section tab and the panel behind it, contributed by a module.
 *
 * Navigation is composed rather than hardcoded because a literal tab list shipped an
 * omitted module's tab and panel in the browser bundle, against invariant 17.
 *
 * `label` is a function so the copy comes from the contributing module's own catalogue: a
 * literal would be untranslatable, and a key into the application's catalogue would leave
 * the omitted module's label in every bundle.
 *
 * Discriminated by `scope`, so a room section's `render` is typed with a non-null `roomId`
 * and cannot be handed top-level props by mistake.
 */
export type SectionContribution = TopSectionContribution | RoomSectionContribution;

export interface TopSectionContribution extends SectionTab {
  readonly scope: 'top';
  readonly render: (props: TopSectionProps) => ReactElement;
}

export interface RoomSectionContribution extends SectionTab {
  readonly scope: 'room';
  readonly render: (props: RoomSectionProps) => ReactElement;
}

export interface BrowserContribution {
  readonly supportContact?: SupportContactSlot;
  readonly branding?: BrandingSlot;
  readonly viewerIntroduction?: ViewerIntroductionSlot;
  readonly sections?: readonly SectionContribution[];
}
