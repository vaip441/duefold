import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { ViewerIdentity } from '../../../core-security/src/authorization.ts';
import { leaseSchema as schema, createLeaseHandler } from './download.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: ViewerIdentity) {
  return createLeaseHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('download lease route runtime not initialized');
}
