import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { heartbeatSchema as schema, createHeartbeatHandler } from './preview-evidence.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createHeartbeatHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('preview heartbeat route runtime not initialized');
}
