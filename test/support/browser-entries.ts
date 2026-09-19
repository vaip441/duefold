/**
 * Test stand-in for the build-time browser-entry registry.
 *
 * In a build, `virtual:duefold/browser-entries` is emitted by the Vite plugin
 * from the generated registry. Under the unit project it resolves here so a
 * component that consumes a module contribution can be rendered. It is empty by
 * default, which is the composition state a test asserts against when the
 * optional module is omitted.
 */

import type { BrowserContribution } from '../../apps/web-client/src/contract.ts';

export interface ComposedBrowserEntry {
  readonly id: string;
  readonly module: string;
  readonly contribution: BrowserContribution;
}

export const composedBrowserEntries: readonly ComposedBrowserEntry[] = [];
