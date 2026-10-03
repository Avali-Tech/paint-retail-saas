import { Alert, Button, Card, Field, PageHeader, Select, Textarea, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent } from 'react';
import { useNavigate } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { COUNT_SCOPES, type CountScope } from '../api/stock-counts.js';
import { useApi } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { StoreSelect } from '../stock/StoreSelect.js';

/** /stock-counts/new — starts a count of a whole store, one brand or one category. */
export function NewStockCountPage() {
  const api = useApi();
  const { t, label } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [storeId, setStoreId] = useState('');
  const [scope, setScope] = useState<CountScope>('full');
  const [scopeId, setScopeId] = useState('');
  const [note, setNote] = useState('');
  const [problems, setProblems] = useState<{ store?: boolean; scopeId?: boolean }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const brands = useQuery({
    queryKey: ['brands'],
    queryFn: () => api.catalog.brands(),
    enabled: scope === 'brand',
  });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
    enabled: scope === 'category',
  });
  const choices =
    scope === 'brand'
      ? (brands.data ?? []).filter((brand) => brand.isActive)
      : (categories.data ?? []);

  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    const found = {
      ...(storeId === '' ? { store: true } : {}),
      ...(scope !== 'full' && scopeId === '' ? { scopeId: true } : {}),
    };
    setProblems(found);
    setMessage(null);
    if (Object.keys(found).length > 0) return;
    setPending(true);
    try {
      const count = await api.stockCounts.start({
        storeId,
        scope,
        ...(scope === 'full' ? {} : { scopeId }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      queryClient.setQueryData(['stock-count', count.id], count);
      await queryClient.invalidateQueries({ queryKey: ['stock-counts'] });
      toast({ title: t('stockCounts.form.started', { number: count.number }), tone: 'success' });
      void navigate(`/stock-counts/${count.id}`);
    } catch (error) {
      setMessage(errorMessage(error));
      setPending(false);
    }
  };

  return (
    <>
      <PageHeader
        title={t('stockCounts.form.title')}
        description={t('stockCounts.form.description')}
      />
      <form
        className="stack"
        noValidate
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        {message !== null && <Alert tone="danger">{message}</Alert>}
        <Card>
          <div className="form-grid">
            <StoreSelect
              label={t('stockCounts.form.store')}
              value={storeId}
              onChange={setStoreId}
              emptyLabel={t('stockCounts.form.chooseStore')}
              error={problems.store ? t('stockCounts.form.required') : undefined}
              required
            />
            <Field label={t('stockCounts.form.scope')}>
              <Select
                value={scope}
                onChange={(event) => {
                  setScope(event.target.value as CountScope);
                  setScopeId('');
                }}
              >
                {COUNT_SCOPES.map((value) => (
                  <option key={value} value={value}>
                    {label('countScope', value)}
                  </option>
                ))}
              </Select>
            </Field>
            {scope !== 'full' && (
              <Field
                label={
                  scope === 'brand' ? t('stockCounts.form.brand') : t('stockCounts.form.category')
                }
                required
                error={problems.scopeId ? t('stockCounts.form.required') : undefined}
              >
                <Select
                  value={scopeId}
                  onChange={(event) => {
                    setScopeId(event.target.value);
                  }}
                >
                  <option value="">{t('stockCounts.form.choose')}</option>
                  {choices.map((choice) => (
                    <option key={choice.id} value={choice.id}>
                      {choice.name}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
          </div>
          <Field label={t('stockCounts.form.note')} className="form-wide">
            <Textarea
              maxLength={500}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          </Field>
        </Card>
        <div className="row row--end">
          <Button type="submit" loading={pending}>
            {t('stockCounts.form.submit')}
          </Button>
        </div>
      </form>
    </>
  );
}
