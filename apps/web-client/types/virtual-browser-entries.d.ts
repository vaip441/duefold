/**
 * Type surface of the build-time virtual module that the browser-entries plugin
 * emits. The values are literal static imports of composed modules' entries; see
 * `build/browser-entries-plugin.ts`.
 *
 * This file stays a global script rather than a module: a top-level import would
 * turn it into one and the `declare module` below would stop being ambient. The
 * contribution shape is therefore imported inside the declaration.
 */

declare module 'virtual:duefold/browser-entries' {
  import type { BrowserContribution } from '@duefold/web-client/contract';

  /*
   * Deliberately NO module identifier and NO entry id. Serializing either into
   * public JavaScript discloses composition/package state on a product surface:
   * entry ids are module-qualified, so they name the module just as directly.
   * Browser code needs the contribution, never the identity of the module that supplied it.
   */
  export interface ComposedBrowserEntry {
    readonly contribution: BrowserContribution;
  }
  export const composedBrowserEntries: readonly ComposedBrowserEntry[];
}
