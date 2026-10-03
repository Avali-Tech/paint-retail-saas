import { Alert, Button, Spinner } from '@paint/ui';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '../api/errors.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';

export interface QueryStateProps<T> {
  readonly query: UseQueryResult<T>;
  /** Heading of the error message, e.g. "Could not load customers". */
  readonly error: MessageKey;
  readonly children: (data: T) => ReactNode;
}

/**
 * The three states of loaded data: a spinner while loading, the error with a
 * "Try again" button (404s say the record cannot be seen), then the content.
 */
export function QueryState<T>({ query, error, children }: QueryStateProps<T>) {
  const { t } = useI18n();
  if (query.isPending) {
    return (
      <div className="query-state">
        <Spinner label={t('common.loading')} />
      </div>
    );
  }
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <Alert
        tone="danger"
        title={t(error)}
        action={
          missing ? undefined : (
            <Button
              variant="secondary"
              onClick={() => {
                void query.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          )
        }
      >
        {missing ? t('common.notFound') : errorMessage(query.error)}
      </Alert>
    );
  }
  return children(query.data);
}
