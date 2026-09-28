import type { WebRuntime } from '../../../../apps/web/src/runtime.ts';
import type { MemberIdentity } from '../../../core-security/src/authorization.ts';
import { documentSchema as schema, createDocumentHandler } from './member-preview.ts';
export { schema };
export function createHandler(runtime: WebRuntime, identity: MemberIdentity) {
  return createDocumentHandler(runtime, identity);
}
export function handler(): never {
  throw new Error('member preview document route runtime not initialized');
}
