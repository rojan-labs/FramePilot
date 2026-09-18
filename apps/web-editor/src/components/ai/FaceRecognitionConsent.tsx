/**
 * The per-project face-recognition opt-in, and the one action that deletes what it stored
 * (plan/background-removal-ai/12 P15, MD-7).
 *
 * Telling people apart across shots is biometric processing. It is off until the editor turns
 * it on for THIS project, it runs on this computer only, and "Delete identity data" removes
 * every stored identity at once and turns recognition off with it. It is shown where the
 * question arises — the face picker — not buried in settings, because that is the moment the
 * editor can tell what they would be agreeing to. Without consent nothing changes for them:
 * they pick the faces, exactly as now.
 */
import { useCallback, useEffect, useState } from 'react';
import { IdentityClient, type IdentityState } from '@framepilot/ai-sdk';
import { Button } from '@framepilot/ui';
import { resolveEngineBaseUrl } from '../../editor/ai.js';

/** The slice of {@link IdentityClient} this component drives; injectable for tests. */
export type IdentityService = Pick<IdentityClient, 'state' | 'setConsent' | 'deleteAll'>;

let shared: IdentityService | undefined;
const defaultService = (): IdentityService =>
  (shared ??= new IdentityClient({ baseUrl: resolveEngineBaseUrl() }));

export function FaceRecognitionConsent({
  projectId,
  service,
}: {
  projectId: string;
  service?: IdentityService;
}): JSX.Element | null {
  const client = service ?? defaultService();
  const [state, setState] = useState<IdentityState | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void client.state(projectId).then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, [client, projectId]);

  const act = useCallback(
    (run: () => Promise<IdentityState>, done: (next: IdentityState) => string | null): void => {
      setBusy(true);
      void run()
        .then((next) => {
          setState(next);
          setReceipt(next.available ? done(next) : 'That could not be saved. Nothing was changed.');
        })
        .finally(() => setBusy(false));
    },
    [],
  );

  // No reachable brain: there is nothing to opt in to, and the editor just picks faces.
  if (state === null || !state.available) return null;

  return (
    <div className="ai-face-consent" role="group" aria-label="face recognition for this project">
      <p>
        {state.consent
          ? 'Face recognition is on for this project.'
          : 'FramePilot can remember who is who in this project, so you choose once instead of every time.'}{' '}
        It runs on this computer only, stays off until you turn it on, and you can delete what it
        stored at any time.
      </p>
      <span className="ai-pack-install__actions">
        <Button
          variant="secondary"
          type="button"
          disabled={busy}
          onClick={() =>
            act(
              () => client.setConsent(projectId, !state.consent),
              (next) =>
                next.consent
                  ? 'Face recognition is on for this project.'
                  : 'Face recognition is off.',
            )
          }
        >
          {state.consent ? 'Turn off' : 'Turn on for this project'}
        </Button>
        {(state.consent || state.people > 0) && (
          <Button
            variant="ghost"
            type="button"
            disabled={busy}
            onClick={() =>
              act(
                () => client.deleteAll(projectId),
                (next) =>
                  `Deleted what FramePilot stored about ${String(next.deletedPeople ?? 0)} ${
                    next.deletedPeople === 1 ? 'person' : 'people'
                  } in this project. Face recognition is off.`,
              )
            }
          >
            Delete identity data
          </Button>
        )}
      </span>
      {receipt !== null && <p role="status">{receipt}</p>}
    </div>
  );
}
