import { Alert, Button, Dialog } from '@paint/ui';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import { errorMessage } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';

export interface FormDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly submitLabel: string;
  /**
   * Checks the fields and saves. Return a message to keep the dialog open and
   * show it, false to keep it open (fields show their own errors), throw (an API
   * error) to show its message, or resolve to close.
   */
  readonly onSubmit: () => Promise<string | false | undefined> | string | false | undefined;
  readonly children: ReactNode;
}

/** A small form in a dialog: the fields, Cancel and a submit button that shows progress. */
export function FormDialog({
  open,
  onClose,
  title,
  description,
  submitLabel,
  onSubmit,
  children,
}: FormDialogProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const close = () => {
    setMessage(null);
    onClose();
  };

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    setPending(true);
    setMessage(null);
    try {
      const problem = await onSubmit();
      if (problem === undefined) close();
      else if (problem !== false) setMessage(problem);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title={title}
      {...(description === undefined ? {} : { description })}
      closeLabel={t('common.close')}
    >
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        {children}
        <div className="row row--end">
          <Button variant="secondary" onClick={close}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" loading={pending}>
            {submitLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
