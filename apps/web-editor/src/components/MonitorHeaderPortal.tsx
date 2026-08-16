import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface MonitorHeaderPortalProps {
  readonly host: HTMLElement | null | undefined;
  readonly children: ReactNode;
}

/**
 * Places monitor-specific controls in the shared Source/Program header.
 * Standalone monitor renders (tests, review players) keep the controls inline.
 */
export function MonitorHeaderPortal({ host, children }: MonitorHeaderPortalProps): JSX.Element {
  return host ? createPortal(children, host) : <>{children}</>;
}
