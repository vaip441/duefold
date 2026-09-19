import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { textSchema as schema, createTextHandler } from './protected-page.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createTextHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('protected text route runtime not initialized');
}
