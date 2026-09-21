/**
 * The module-facing surface of the application, and the only thing a first-party
 * module may import from it.
 *
 * WHY THIS EXISTS. Module browser code reached into eight separate app paths, each export
 * added so one module would compile. The app then had no way to tell which internals were
 * load-bearing for a module and which were private, so refactoring any of them silently
 * broke an OPTIONAL module — a breakage a minimal composition would not even surface.
 *
 * What is re-exported here is promised to modules; everything else is private. A module
 * needing something new adds it here, which makes that a visible decision rather than a new
 * import path. `test/unit/module-boundary.test.ts` fails if one reaches past it.
 *
 * Deliberately narrow: transport, failure presentation, shared primitives, and validation
 * shared with the server contract. Not application state, not navigation, not another
 * section's loader. This is not a plugin SDK and carries no versioning promise — modules are
 * composed at build time from this repository, so a change here lands with its callers.
 */

export {
  ApiError,
  isRecord,
  json,
  requireNumber,
  requireString,
  type UploadIntentResponse,
} from './api/client.ts';
export { formatMessage, type MessageValues } from './i18n/format.ts';
/* The application catalogue, for the shared failure and action copy a module must not
   restate in its own words: "Reload" meaning two different things in two panels is a
   worse outcome than the coupling. A module's OWN copy lives in its own catalogue. */
export { translate, type MessageKey } from './i18n/translate.ts';
export { Notice } from './components/Notice.tsx';
export { planParts } from './components/UploadPanel.tsx';
export { presentFailure, type PresentedFailure } from './workspace/failures.ts';
export { validateAccent, validateSupportContact } from './workspace/state.ts';
export { transferParts } from './workspace/upload.ts';
export type {
  BrandingSlot,
  BrowserContribution,
  EffectiveBrand,
  RoomSectionContribution,
  RoomSectionProps,
  SectionContribution,
  SectionProps,
  SectionTab,
  SupportContact,
  SupportContactSlot,
  TopSectionContribution,
  TopSectionProps,
  ViewerIntroductionSlot,
} from './contract.ts';
