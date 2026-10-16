import type { StatementPreview, StatementRowProblem } from '@paint/shared';
import { Alert, Button, Card, Field, Input, PageHeader, Select, Table, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage, type ApiError } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { useI18n, type MessageKey } from '../i18n/i18n.js';
import { parseRupees } from '../lib/inputs.js';
import { SectionNav } from '../lib/SectionNav.js';
import { PURCHASING_SECTIONS } from '../purchasing/sections.js';
import type { StatementUpload } from './statements-api.js';
import { statementsKey } from './StatementsPage.js';
import { templatesKey } from './TemplatesPage.js';

/** Lines shown in the preview; the rest are counted. */
const SHOWN = 50;

/** A signed rupee amount typed by a person, as paise; undefined when left empty, null when wrong. */
export function signedPaise(text: string): number | undefined | null {
  const value = text.trim();
  if (value === '') return undefined;
  const paise = parseRupees(value.replace(/^-/, ''));
  if (paise === null) return null;
  return value.startsWith('-') ? -paise : paise;
}

function Problems({
  title,
  rows,
}: {
  readonly title: MessageKey;
  readonly rows: readonly StatementRowProblem[];
}) {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <Card title={t(title)}>
      <ul className="statement-problems">
        {rows.map((row) => (
          <li key={`${String(row.row)}:${String(row.column)}`}>
            <strong>
              {row.row === 0
                ? t('statements.uploadPage.fileProblem')
                : t('statements.uploadPage.row', { row: String(row.row) })}
            </strong>{' '}
            {row.message}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PreviewView({ preview }: { readonly preview: StatementPreview }) {
  const { t, money, date, label, number } = useI18n();
  return (
    <div className="stack">
      {preview.duplicateOf !== null && (
        <Alert tone="warning">
          {t('statements.uploadPage.duplicate', { number: preview.duplicateOf })}
        </Alert>
      )}
      <Problems title="statements.uploadPage.errors" rows={preview.errors} />
      {preview.lines.length > 0 && (
        <Card>
          <div className="stack">
            <p>
              {t('statements.uploadPage.summary', {
                lines: number(preview.lines.length),
                from: date(String(preview.periodFrom)),
                to: date(String(preview.periodTo)),
                debits: money(preview.debitsPaise),
                credits: money(preview.creditsPaise),
              })}
            </p>
            {preview.lines.length > SHOWN && (
              <p className="muted">
                {t('statements.uploadPage.more', {
                  shown: number(SHOWN),
                  count: number(preview.lines.length),
                })}
              </p>
            )}
            <Table label={t('statements.reconcile.brandSide')}>
              <thead>
                <tr>
                  <th scope="col">{t('statements.reconcile.columns.date')}</th>
                  <th scope="col">{t('statements.reconcile.columns.document')}</th>
                  <th scope="col">{t('statements.reconcile.columns.kind')}</th>
                  <th scope="col">{t('statements.reconcile.columns.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.slice(0, SHOWN).map((line) => (
                  <tr key={line.rowNumber}>
                    <td>{date(line.lineDate)}</td>
                    <td>{line.documentNumber ?? '—'}</td>
                    <td>{label('statementLineKind', line.kind)}</td>
                    <td className="numeric">{money(line.amountPaise)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        </Card>
      )}
      <Problems title="statements.uploadPage.skipped" rows={preview.skipped} />
    </div>
  );
}

/** /brand-statements/upload — choose the template and the file, check it, import it. */
export function UploadPage() {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const templates = useQuery({
    queryKey: templatesKey,
    queryFn: ({ signal }) => api.statements.templates(signal),
  });
  const active = (templates.data ?? []).filter((template) => template.isActive);
  const [values, setValues] = useState({
    templateId: '',
    periodFrom: '',
    periodTo: '',
    opening: '',
    closing: '',
  });
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StatementPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState<'preview' | 'import' | null>(null);
  const text = (field: keyof typeof values) => ({
    value: values[field],
    onChange: (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
    },
  });

  const upload = (): StatementUpload | string => {
    if (values.templateId === '') return t('statements.uploadPage.chooseTemplate');
    if (file === null) return t('statements.uploadPage.chooseFile');
    const opening = signedPaise(values.opening);
    const closing = signedPaise(values.closing);
    if (opening === null || closing === null) return t('statements.uploadPage.invalidAmount');
    return {
      templateId: values.templateId,
      file,
      ...(values.periodFrom === '' ? {} : { periodFrom: values.periodFrom }),
      ...(values.periodTo === '' ? {} : { periodTo: values.periodTo }),
      ...(opening === undefined ? {} : { openingBalancePaise: opening }),
      ...(closing === undefined ? {} : { closingBalancePaise: closing }),
    };
  };

  const run = async (action: 'preview' | 'import') => {
    const request = upload();
    if (typeof request === 'string') {
      setMessage(request);
      return;
    }
    setMessage(null);
    setPending(action);
    try {
      if (action === 'preview') {
        setPreview(await api.statements.preview(request));
      } else {
        const detail = await api.statements.import(request);
        await queryClient.invalidateQueries({ queryKey: statementsKey });
        toast({ title: t('statements.uploadPage.imported'), tone: 'success' });
        await navigate(`/brand-statements/${detail.statement.id}`);
      }
    } catch (error) {
      setMessage(errorMessage(error));
      // A file with rows the template cannot read comes back with what it read.
      // The API client's errors are all ApiErrors.
      const read = (error as ApiError).body.preview as StatementPreview | undefined;
      if (read !== undefined) setPreview(read);
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <PageHeader
        title={t('statements.uploadPage.title')}
        description={t('statements.uploadPage.description')}
      />
      <SectionNav label="purchasing.sections" links={PURCHASING_SECTIONS} />
      <form
        noValidate
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void run('import');
        }}
      >
        <Card>
          <div className="stack">
            {message !== null && <Alert tone="danger">{message}</Alert>}
            {templates.isSuccess && active.length === 0 && (
              <Alert tone="info">{t('statements.uploadPage.noTemplates')}</Alert>
            )}
            <div className="form-grid">
              <Field label={t('statements.uploadPage.template')}>
                <Select {...text('templateId')}>
                  <option value="">{t('statements.uploadPage.chooseTemplate')}</option>
                  {active.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name} · {template.supplier.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('statements.uploadPage.file')}>
                <Input
                  type="file"
                  accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] ?? null);
                    setPreview(null);
                  }}
                />
              </Field>
              <Field
                label={t('statements.uploadPage.periodFrom')}
                hint={t('statements.uploadPage.periodHint')}
              >
                <Input type="date" {...text('periodFrom')} />
              </Field>
              <Field label={t('statements.uploadPage.periodTo')}>
                <Input type="date" {...text('periodTo')} />
              </Field>
              <Field
                label={t('statements.uploadPage.opening')}
                hint={t('statements.uploadPage.balanceHint')}
              >
                <Input inputMode="decimal" {...text('opening')} />
              </Field>
              <Field label={t('statements.uploadPage.closing')}>
                <Input inputMode="decimal" {...text('closing')} />
              </Field>
            </div>
            <div className="row row--end">
              <Button
                variant="secondary"
                loading={pending === 'preview'}
                onClick={() => {
                  void run('preview');
                }}
              >
                {t('statements.uploadPage.preview')}
              </Button>
              <Button type="submit" loading={pending === 'import'}>
                {t('statements.uploadPage.import')}
              </Button>
            </div>
          </div>
        </Card>
        {preview !== null && <PreviewView preview={preview} />}
      </form>
    </>
  );
}
