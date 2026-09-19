import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { rangeSchema as schema, createRangeHandler } from './download.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createRangeHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('download range route runtime not initialized');
}
