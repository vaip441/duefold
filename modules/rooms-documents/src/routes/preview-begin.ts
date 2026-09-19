import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { beginSchema as schema, createBeginHandler } from './preview-evidence.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createBeginHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('preview begin route runtime not initialized');
}
