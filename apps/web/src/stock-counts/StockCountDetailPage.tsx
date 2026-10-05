import { Alert, Badge, Button, Card, Field, Input, PageHeader, Table, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type SyntheticEvent } from 'react';
import { useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import type { StockCount } from '../api/stock-counts.js';
import { useApi } from '../app/services.js';
import { useCurrentProfile, usePermissions } from '../auth/session.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ReasonDialog } from '../lib/ReasonDialog.js';
import { refreshInventory } from '../lib/refresh.js';
import { useStoreAccess } from '../stock/StoreSelect.js';
import { parseNonNegative } from '../transfers/quantity.js';
import { ApproveDialog, SubmitDialog } from './CountDialogs.js';
import { COUNT_TONE } from './StockCountsPage.js';

/** The most counts the API takes in one request. */
export const COUNTS_PER_REQUEST = 500;

/** Keeps the latest version of a count everywhere it is shown. */
function useSaveCount() {
  const queryClient = useQueryClient();
  return async (count: StockCount) => {
    queryClient.setQueryData(['stock-count', count.id], count);
    await queryClient.invalidateQueries({ queryKey: ['stock-counts'] });
  };
}

/**
 * The counter's scan box: a scanner types the code and presses Enter, adding one.
 * Focus stays in the box so the next scan can follow at once.
 */
function ScanBox({ count }: { readonly count: StockCount }) {
  const api = useApi();
  const { t, number } = useI18n();
  const save = useSaveCount();
  const input = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState('');
  const [feedback, setFeedback] = useState('');
  const [pending, setPending] = useState(false);

  const scan = async (event: SyntheticEvent) => {
    event.preventDefault();
    const value = code.trim();
    if (value === '') return;
    setPending(true);
    try {
      const saved = await api.stockCounts.record(count.id, [{ code: value, mode: 'add' }]);
      const before = new Map(count.lines.map((line) => [line.variantId, line.countedQuantity]));
      const changed = saved.lines.find(
        (line) => before.get(line.variantId) !== line.countedQuantity,
      );
      setFeedback(
        changed === undefined
          ? t('stockCounts.detail.scannedCode', { code: value })
          : t('stockCounts.detail.scanned', {
              sku: changed.sku,
              count: number(Number(changed.countedQuantity)),
            }),
      );
      setCode('');
      await save(saved);
    } catch (error) {
      setFeedback(errorMessage(error));
    } finally {
      setPending(false);
      input.current?.focus();
    }
  };

  return (
    <form
      className="lookup"
      noValidate
      onSubmit={(event) => {
        void scan(event);
      }}
    >
      <Field label={t('stockCounts.detail.scan')} hint={t('stockCounts.detail.scanHint')}>
        <Input
          ref={input}
          inputMode="search"
          autoComplete="off"
          enterKeyHint="go"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
      </Field>
      <Button type="submit" variant="secondary" loading={pending}>
        {t('stockCounts.detail.scanButton')}
      </Button>
      <p className="scan-feedback" role="status">
        {feedback}
      </p>
    </form>
  );
}

function Lines({ count, editable }: { readonly count: StockCount; readonly editable: boolean }) {
  const api = useApi();
  const { t, number, money } = useI18n();
  const toast = useToast();
  const save = useSaveCount();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [invalid, setInvalid] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const shown = (value: number | null) => (value === null ? t('common.none') : number(value));

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const entries = Object.entries(drafts).map(([variantId, text]) => ({
      variantId,
      quantity: parseNonNegative(text),
    }));
    const bad = entries.filter((entry) => entry.quantity === null).map((entry) => entry.variantId);
    setInvalid(bad);
    setMessage(null);
    if (bad.length > 0) return;
    setPending(true);
    try {
      const counts = entries.map((entry) => ({
        variantId: entry.variantId,
        quantity: Number(entry.quantity),
        mode: 'set' as const,
      }));
      let saved = count;
      for (let start = 0; start < counts.length; start += COUNTS_PER_REQUEST) {
        saved = await api.stockCounts.record(
          count.id,
          counts.slice(start, start + COUNTS_PER_REQUEST),
        );
      }
      setDrafts({});
      await save(saved);
      toast({ title: t('stockCounts.detail.countsSaved'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  if (count.lines.length === 0) return <p className="muted">{t('stockCounts.detail.noLines')}</p>;
  return (
    <form
      className="stack"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      {message !== null && <Alert tone="danger">{message}</Alert>}
      {invalid.length > 0 && <Alert tone="danger">{t('stockCounts.detail.countInvalid')}</Alert>}
      <Table label={t('stockCounts.detail.lines')}>
        <thead>
          <tr>
            <th scope="col">{t('stockCounts.detail.product')}</th>
            <th scope="col" className="ui-num">
              {t('stockCounts.detail.books')}
            </th>
            <th scope="col" className="ui-num">
              {t('stockCounts.detail.countedColumn')}
            </th>
            <th scope="col" className="ui-num">
              {t('stockCounts.detail.variance')}
            </th>
            <th scope="col" className="ui-num">
              {t('stockCounts.detail.value')}
            </th>
          </tr>
        </thead>
        <tbody>
          {count.lines.map((line) => (
            <tr key={line.variantId}>
              <th scope="row">
                {line.sku}
                <span className="cell-meta">
                  {line.brandName} {line.productName}
                </span>
              </th>
              <td className="ui-num">{number(line.expectedQuantity)}</td>
              <td className="ui-num">
                {editable ? (
                  <Input
                    className="count-input"
                    inputMode="decimal"
                    aria-label={t('stockCounts.detail.countOf', { sku: line.sku })}
                    aria-invalid={invalid.includes(line.variantId) ? true : undefined}
                    value={
                      drafts[line.variantId] ??
                      (line.countedQuantity === null ? '' : String(line.countedQuantity))
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((current) => ({ ...current, [line.variantId]: value }));
                    }}
                  />
                ) : (
                  shown(line.countedQuantity)
                )}
              </td>
              <td className="ui-num">{shown(line.variance)}</td>
              <td className="ui-num">
                {line.varianceValuePaise === null
                  ? t('common.none')
                  : money(line.varianceValuePaise)}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>
      {editable && (
        <div className="row row--end">
          <Button
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={Object.keys(drafts).length === 0}
          >
            {t('stockCounts.detail.saveCounts')}
          </Button>
        </div>
      )}
    </form>
  );
}

type Action = 'submit' | 'approve' | 'cancel';

function CountView({ count }: { readonly count: StockCount }) {
  const api = useApi();
  const { t, label, number, money, dateTime } = useI18n();
  const toast = useToast();
  const can = usePermissions();
  const profile = useCurrentProfile();
  const access = useStoreAccess();
  const save = useSaveCount();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<Action | null>(null);
  const [reopening, setReopening] = useState(false);
  const manage = can('inventory:manage') && access(count.store.id);
  const counting = manage && count.status === 'counting';
  const submitted = manage && count.status === 'submitted';
  // Someone else approves a count you submitted, unless you work at every store (as the API rules).
  const ownSubmission = count.submittedBy?.memberId === profile.memberId && !profile.allStores;
  const { summary } = count;
  const close = () => {
    setAction(null);
  };
  const run = async (work: Promise<StockCount>, done: MessageKey) => {
    const saved = await work;
    await save(saved);
    // Approval posts corrections, and every step changes what the stock screens show.
    await refreshInventory(queryClient, ['stock-count', saved.id]);
    toast({ title: t(done), tone: 'success' });
  };
  const steps: [MessageKey, string | null, string?][] = [
    ['stockCounts.detail.startedAt', count.startedAt, count.startedBy.name],
    ['stockCounts.detail.submittedAt', count.submittedAt, count.submittedBy?.name],
    ['stockCounts.detail.approvedAt', count.approvedAt],
    ['stockCounts.detail.closedAt', count.closedAt],
  ];
  const actionButton = (name: Action, key: MessageKey, variant: 'primary' | 'secondary') => (
    <Button
      variant={variant}
      aria-label={`${t(key)} ${count.number}`}
      onClick={() => {
        setAction(name);
      }}
    >
      {t(key)}
    </Button>
  );

  return (
    <>
      <PageHeader
        title={count.number}
        description={
          <span className="badges">
            <Badge tone={COUNT_TONE[count.status]}>{label('countStatus', count.status)}</Badge>
            <span className="muted">
              {t('stockCounts.detail.subtitle', {
                store: `${count.store.code} · ${count.store.name}`,
                scope: label('countScope', count.scope),
              })}
            </span>
          </span>
        }
        actions={
          <span className="row">
            {counting && actionButton('submit', 'stockCounts.detail.submit', 'primary')}
            {submitted && (
              <>
                {!ownSubmission && actionButton('approve', 'stockCounts.detail.approve', 'primary')}
                <Button
                  variant="secondary"
                  loading={reopening}
                  onClick={() => {
                    setReopening(true);
                    run(api.stockCounts.reopen(count.id), 'stockCounts.detail.reopened')
                      .catch((error: unknown) => {
                        toast({ title: errorMessage(error), tone: 'danger' });
                      })
                      .finally(() => {
                        setReopening(false);
                      });
                  }}
                >
                  {t('stockCounts.detail.reopen')}
                </Button>
              </>
            )}
            {(counting || submitted) &&
              actionButton('cancel', 'stockCounts.detail.cancel', 'secondary')}
          </span>
        }
      />
      <div className="stack">
        <Card title={t('stockCounts.detail.summary')}>
          <div className="stack">
            {submitted && ownSubmission && (
              <Alert tone="info">{t('stockCounts.detail.ownSubmission')}</Alert>
            )}
            <dl className="facts">
              <div>
                <dt>{t('stockCounts.detail.counted')}</dt>
                <dd>
                  {t('stockCounts.detail.countedValue', {
                    counted: number(summary.countedLines),
                    total: number(summary.totalLines),
                  })}
                </dd>
              </div>
              <div>
                <dt>{t('stockCounts.detail.accuracy')}</dt>
                <dd>
                  {summary.accuracyPercent === null
                    ? t('common.none')
                    : t('stockCounts.accuracy.percentValue', {
                        percent: number(summary.accuracyPercent),
                      })}
                </dd>
              </div>
              <div>
                <dt>{t('stockCounts.detail.netVariance')}</dt>
                <dd>{money(summary.netVarianceValuePaise)}</dd>
              </div>
              <div>
                <dt>{t('stockCounts.detail.absoluteVariance')}</dt>
                <dd>{money(summary.absoluteVarianceValuePaise)}</dd>
              </div>
            </dl>
            <ol className="timeline">
              {steps
                .filter((step): step is [MessageKey, string, string?] => step[1] !== null)
                .map(([key, time, name]) => (
                  <li key={key} data-done="">
                    {t(key, { time: dateTime(time) })}
                    {name !== undefined && ` · ${name}`}
                  </li>
                ))}
            </ol>
            {count.note !== null && <p>{t('stockCounts.detail.note', { note: count.note })}</p>}
            {count.closingReason !== null && (
              <p>{t('stockCounts.detail.closingReason', { reason: count.closingReason })}</p>
            )}
          </div>
        </Card>
        {counting && (
          <Card>
            <ScanBox count={count} />
          </Card>
        )}
        <Card title={t('stockCounts.detail.lines')}>
          <Lines key={count.status} count={count} editable={counting} />
        </Card>
      </div>

      {action === 'submit' && (
        <SubmitDialog
          count={count}
          onClose={close}
          onSubmit={(asZero) =>
            run(api.stockCounts.submit(count.id, asZero), 'stockCounts.detail.submitted')
          }
        />
      )}
      {action === 'approve' && (
        <ApproveDialog
          count={count}
          onClose={close}
          onSubmit={(reasons) =>
            run(api.stockCounts.approve(count.id, reasons), 'stockCounts.detail.approved')
          }
        />
      )}
      {action === 'cancel' && (
        <ReasonDialog
          title={t('stockCounts.detail.cancelTitle', { number: count.number })}
          submitLabel={t('stockCounts.detail.cancel')}
          onClose={close}
          onSubmit={(reason) =>
            run(api.stockCounts.cancel(count.id, reason), 'stockCounts.detail.cancelled')
          }
        />
      )}
    </>
  );
}

/** /stock-counts/:id */
export function StockCountDetailPage() {
  const api = useApi();
  const id = String(useParams().id);
  const count = useQuery({
    queryKey: ['stock-count', id],
    queryFn: ({ signal }) => api.stockCounts.get(id, signal),
  });
  return (
    <QueryState query={count} error="stockCounts.detail.error">
      {(data) => <CountView count={data} />}
    </QueryState>
  );
}
