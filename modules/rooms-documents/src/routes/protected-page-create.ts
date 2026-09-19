import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { createSchema as schema, createWatermarkHandler } from './protected-page.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createWatermarkHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('protected page create route runtime not initialized');
}
