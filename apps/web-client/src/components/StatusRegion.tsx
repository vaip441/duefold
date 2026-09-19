/**
 * Live region for asynchronous status.
 *
 * One polite live region per view, rendered empty on first paint and updated
 * when an operation starts or settles, so a screen-reader user learns about
 * pending work and outcomes that are otherwise only visible.
 */

export interface StatusRegionProps {
  readonly message: string;
  readonly label: string;
}

export function StatusRegion({ message, label }: StatusRegionProps): React.ReactElement {
  return (
    <div role="status" aria-live="polite" aria-label={label} className="df-visually-hidden">
      {message}
    </div>
  );
}
