import { Button, useToast } from '@paint/ui';
import { useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';

/** The schemes or their claims as CSV, through the reports framework. */
export function CsvButton({ kind }: { readonly kind: 'brand-schemes' | 'brand-scheme-claims' }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  // Downloads need data:export (the API refuses them too).
  if (!usePermissions()('data:export')) return null;
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={() => {
        setBusy(true);
        api.schemes
          .csv(kind)
          .then((file) => {
            saveFile(file.blob, file.fileName ?? `${kind}.csv`);
          })
          .catch((error: unknown) => {
            toast({
              title: t('schemes.csvFailed'),
              description: errorMessage(error),
              tone: 'danger',
            });
          })
          .finally(() => {
            setBusy(false);
          });
      }}
    >
      {t('schemes.csv')}
    </Button>
  );
}
