import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { closeSchema as schema, createCloseHandler } from './preview-evidence.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createCloseHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('preview close route runtime not initialized');
}
