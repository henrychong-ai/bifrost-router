import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

export interface CredentialTargetDialogProps {
  /** The credential-named parameters the write was refused on; null = closed. */
  parameters: string[] | null;
  /** The action word for the confirm button: Create, Save, Enable, Transfer. */
  verb: string;
  /** True while the acknowledged retry is in flight. */
  pending: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The confirmation a route write raises when its TARGET carries a
 * credential-named query parameter.
 *
 * The server refuses such a write with `ROUTE_TARGET_CREDENTIAL` unless the
 * request acknowledges it, so this dialog is the only way the dashboard can
 * supply that acknowledgement. It names the PARAMETERS and never the values —
 * the server does not send them, and a value on screen would be one more place
 * a credential lives.
 */
export function CredentialTargetDialog({
  parameters,
  verb,
  pending,
  onConfirm,
  onCancel,
}: CredentialTargetDialogProps) {
  const plural = parameters !== null && parameters.length !== 1;

  return (
    <AlertDialog open={parameters !== null} onOpenChange={() => !pending && onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="font-inter font-semibold text-blue-950">
            This target looks like it carries a credential
          </AlertDialogTitle>
          <AlertDialogDescription className="font-inter">
            The target contains credential-named parameter{plural ? 's' : ''}:{' '}
            <code className="font-mono text-blue-600">{parameters?.join(', ')}</code>.
            <br />
            <br />A short link is a public handle: anyone who opens it exercises whatever{' '}
            {plural ? 'those parameters carry' : 'that parameter carries'}, and the target is stored
            in the route, in the click analytics and in the request log. Continue only if the value
            is genuinely not a secret.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel className="font-inter" disabled={pending}>
            Cancel
          </AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={pending}
            className="bg-blue-950 font-inter hover:bg-blue-900"
          >
            {pending ? 'Working...' : `${verb} anyway`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
