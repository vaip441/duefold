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
 * What a contributed section receives.
 *
 * `ReactElement` is imported rather than reached for through a global `React`
 * namespace: this file is also read by the Node project, which carries no DOM or
 * JSX globals, so an ambient reference would fail to type-check there.
 *
 * Deliberately narrow. A section that needed the room's working entries, its
 * revisions, or another section's loader would be core navigation wearing a
 * contribution's clothes; a contributed section owns its own state and reaches the
 * server itself. `roomId` is null on the top-level workbench, where a room-scoped
 * section is never rendered.
 */
export interface SectionProps {
  readonly roomId: string | null;
  /** Announces through the frame's single polite live region. */
  readonly onStatus: (message: string) => void;
}

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
 * A section tab and panel a module contributes.
 *
 * This exists so section navigation is composed rather than hardcoded. A
 * hardcoded tab list shipped an omitted module's tab and panel in the browser
 * bundle, which contradicts the invariant that an omitted module is ABSENT from
 * production artifacts rather than hidden by a runtime check.
 *
 * `label` is a function, not a string, so the copy comes from the contributing
 * module's own catalogue. A literal here would be untranslatable copy, and a key
 * into the application's catalogue would leave the omitted module's label in every
 * bundle.
 */
export interface SectionContribution extends SectionTab {
  readonly render: (props: SectionProps) => ReactElement;
}

export interface BrowserContribution {
  readonly supportContact?: SupportContactSlot;
  readonly branding?: BrandingSlot;
  readonly viewerIntroduction?: ViewerIntroductionSlot;
  readonly sections?: readonly SectionContribution[];
}
