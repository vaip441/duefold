/**
 * The room preparation path: Collection, Access, Review, Publish.
 *
 * Only the steps this member can take are shown. A Contributor stages content but
 * neither manages readers nor publishes, so their path is Collection and Review;
 * offering the other steps would lead them to a refusal.
 *
 * Publish ends the path but is not a section: it opens the server's dry-run dialog, and
 * it is the room's one primary action, so it is not duplicated anywhere else.
 */

import { translate, type MessageKey } from '../i18n/translate.ts';

type StepId = 'collection' | 'access' | 'review';

const STEP_SECTIONS: Readonly<Record<StepId, readonly string[]>> = {
  collection: ['structure', 'upload'],
  access: ['participants'],
  review: ['processing'],
};

const STEP_LABEL: Readonly<Record<StepId, MessageKey>> = {
  collection: 'workspace.steps.collection',
  access: 'workspace.steps.access',
  review: 'workspace.steps.review',
};

export interface RoomPreparationNavProps {
  readonly canManage: boolean;
  readonly sectionId: string;
  readonly onSelect: (sectionId: string) => void;
  readonly onPublish: () => void;
}

export function RoomPreparationNav({
  canManage,
  sectionId,
  onSelect,
  onPublish,
}: RoomPreparationNavProps): React.ReactElement {
  const steps: readonly StepId[] = canManage
    ? ['collection', 'access', 'review']
    : ['collection', 'review'];
  return (
    <nav className="df-preparation" aria-label={translate('workspace.steps.label')}>
      {steps.map((step, index) => (
        <button
          key={step}
          type="button"
          className="df-preparation__step"
          aria-current={STEP_SECTIONS[step].includes(sectionId) ? 'step' : undefined}
          onClick={() => {
            onSelect(STEP_SECTIONS[step][0] ?? 'structure');
          }}
        >
          <span className="df-preparation__number" aria-hidden="true">
            {index + 1}
          </span>{' '}
          {translate(STEP_LABEL[step])}
        </button>
      ))}
      {canManage ? (
        <button
          type="button"
          className="df-button df-button--primary df-preparation__publish"
          onClick={onPublish}
        >
          {translate('publish.action')}
        </button>
      ) : null}
    </nav>
  );
}
