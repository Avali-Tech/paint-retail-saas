import {
  Alert,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  PageHeader,
  Select,
  Table,
  useToast,
} from '@paint/ui';
import {
  ACCOUNTING_EXPORT_FORMATS,
  ACCOUNTING_EXPORT_KINDS,
  type AccountingExportFormat,
  type AccountingExportKind,
  type AccountingExportPreview,
  type AccountingExportView,
} from '@paint/shared';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { saveFile } from '../lib/download.js';
import { isDate, todayInIndia } from '../lib/india-time.js';
import { QueryState } from '../lib/QueryState.js';
import { AccountingNav } from './AccountingNav.js';

export const HISTORY_SHOWN = 20;
const historyKey = ['accounting-exports'] as const;

/** What the period holds, what is left to enter by hand, and every problem in the way. */
function PreviewPanel({ preview }: { readonly preview: AccountingExportPreview }) {
  const { t, label, plural } = useI18n();
  const { refunds, bouncedCheques } = preview.manual;
  return (
    <div className="stack" aria-live="polite">
      <dl className="facts" aria-label={t('books.export.counts')}>
        {ACCOUNTING_EXPORT_KINDS.map((kind) => (
          <div key={kind}>
            <dt>{label('exportKinds', kind)}</dt>
            <dd>{preview.counts[kind]}</dd>
          </div>
        ))}
      </dl>
      {refunds + bouncedCheques > 0 && (
        <Alert tone="info">
          {t('books.export.manual', {
            refunds: plural('books.export.refunds', refunds),
            bounced: plural('books.export.bounced', bouncedCheques),
          })}
        </Alert>
      )}
      {preview.problems.length > 0 && (
        <Alert tone="danger">
          <p>{t('books.export.problems')}</p>
          <ul className="problems">
            {preview.problems.map((problem, index) => (
              <li key={index}>{problem.message}</li>
            ))}
          </ul>
          <Link to="/accounting/ledgers">{t('books.export.mapLedgers')}</Link>
        </Alert>
      )}
    </div>
  );
}

/** Past exports, each downloadable again when its file was kept. */
function History() {
  const api = useApi();
  const { t, label, dateTime, date } = useI18n();
  const [message, setMessage] = useState<string | null>(null);
  const history = useQuery({
    queryKey: historyKey,
    queryFn: ({ signal }) => api.books.exports(0, HISTORY_SHOWN, signal),
  });
  const download = async (row: AccountingExportView, documentId: string) => {
    setMessage(null);
    try {
      const file = await api.documents.download(documentId);
      saveFile(file.blob, file.fileName ?? `tally-${row.periodFrom}-to-${row.periodTo}`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  };
  return (
    <Card title={t('books.export.history')}>
      <div className="stack">
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <QueryState query={history} error="books.export.historyError">
          {(page) =>
            page.items.length === 0 ? (
              <p className="muted">{t('books.export.noHistory')}</p>
            ) : (
              <Table label={t('books.export.history')}>
                <thead>
                  <tr>
                    <th scope="col">{t('books.export.period')}</th>
                    <th scope="col">{t('books.export.kinds')}</th>
                    <th scope="col">{t('books.export.vouchers')}</th>
                    <th scope="col">{t('books.export.by')}</th>
                    <th scope="col">{t('books.export.file')}</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((row) => (
                    <tr key={row.id}>
                      <th scope="row">
                        {t('books.export.range', {
                          from: date(row.periodFrom),
                          to: date(row.periodTo),
                        })}
                        <span className="cell-meta">{label('exportFormats', row.format)}</span>
                      </th>
                      <td>{row.kinds.map((kind) => label('exportKinds', kind)).join(', ')}</td>
                      <td>{row.voucherCount}</td>
                      <td>
                        {row.createdBy}
                        <span className="cell-meta">{dateTime(row.createdAt)}</span>
                      </td>
                      <td>
                        {row.documentId === null ? (
                          t('books.export.notKept')
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => {
                              void download(row, String(row.documentId));
                            }}
                          >
                            {t('books.export.download')}
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )
          }
        </QueryState>
      </div>
    </Card>
  );
}

/** /accounting/export — a period's invoices, notes and receipts for Tally (spec §6.1). */
export function AccountingExportPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const today = todayInIndia();
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [kinds, setKinds] = useState<readonly AccountingExportKind[]>(ACCOUNTING_EXPORT_KINDS);
  const [format, setFormat] = useState<AccountingExportFormat>('tally_xml');
  const [companyName, setCompanyName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const backwards = isDate(from) && isDate(to) && to < from;
  const ready = isDate(from) && isDate(to) && !backwards && kinds.length > 0;
  const query = { from, to, kinds };
  const preview = useQuery({
    queryKey: ['accounting-exports', 'preview', query],
    queryFn: ({ signal }) => api.books.exportPreview(query, signal),
    enabled: ready,
    placeholderData: keepPreviousData,
    // Bills, receipts and mappings change elsewhere: check afresh each time the page opens.
    staleTime: 0,
  });
  const data = preview.data;
  const total = data === undefined ? 0 : Object.values(data.counts).reduce((a, b) => a + b, 0);
  const canExport = ready && data?.problems.length === 0 && total > 0;

  const exportNow = async () => {
    setMessage(null);
    setPending(true);
    try {
      const name = companyName.trim();
      const file = await api.books.exportFile({
        ...query,
        format,
        ...(name === '' ? {} : { companyName: name }),
      });
      saveFile(file.blob, file.fileName ?? `tally-${from}-to-${to}`);
      toast({ title: t('books.export.done'), tone: 'success' });
      await queryClient.invalidateQueries({ queryKey: historyKey });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('books.accounting.title')}
        description={t('books.accounting.description')}
      />
      <AccountingNav />
      <div className="stack">
        <Card title={t('books.export.title')}>
          <div className="stack">
            {message !== null && <Alert tone="danger">{message}</Alert>}
            <div className="form-grid">
              <Field label={t('books.export.from')}>
                <Input
                  type="date"
                  value={from}
                  onChange={(event) => {
                    setFrom(event.target.value);
                  }}
                />
              </Field>
              <Field
                label={t('books.export.to')}
                error={backwards ? t('books.export.backwards') : undefined}
              >
                <Input
                  type="date"
                  value={to}
                  onChange={(event) => {
                    setTo(event.target.value);
                  }}
                />
              </Field>
              <Field label={t('books.export.format')}>
                <Select
                  value={format}
                  onChange={(event) => {
                    setFormat(event.target.value as AccountingExportFormat);
                  }}
                >
                  {ACCOUNTING_EXPORT_FORMATS.map((value) => (
                    <option key={value} value={value}>
                      {label('exportFormats', value)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('books.export.company')} hint={t('books.export.companyHint')}>
                <Input
                  value={companyName}
                  placeholder={data?.companyName}
                  maxLength={200}
                  onChange={(event) => {
                    setCompanyName(event.target.value);
                  }}
                />
              </Field>
            </div>
            <fieldset className="export-kinds">
              <legend>{t('books.export.kinds')}</legend>
              {ACCOUNTING_EXPORT_KINDS.map((kind) => (
                <Checkbox
                  key={kind}
                  label={label('exportKinds', kind)}
                  checked={kinds.includes(kind)}
                  onChange={(event) => {
                    setKinds(
                      ACCOUNTING_EXPORT_KINDS.filter((value) =>
                        value === kind ? event.target.checked : kinds.includes(value),
                      ),
                    );
                  }}
                />
              ))}
            </fieldset>
            {kinds.length === 0 && <Alert tone="warning">{t('books.export.chooseKind')}</Alert>}
            {ready && (
              <QueryState query={preview} error="books.export.previewError">
                {(shown) => <PreviewPanel preview={shown} />}
              </QueryState>
            )}
            {data !== undefined && total === 0 && data.problems.length === 0 && (
              <p className="muted">{t('books.export.nothing')}</p>
            )}
            <div className="row row--end">
              <Button
                disabled={!canExport}
                loading={pending}
                onClick={() => {
                  void exportNow();
                }}
              >
                {t('books.export.export')}
              </Button>
            </div>
          </div>
        </Card>
        <History />
      </div>
    </>
  );
}
