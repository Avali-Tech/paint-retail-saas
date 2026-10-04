import { Badge, Button, Card, Field, Input, PageHeader, Select, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type SyntheticEvent, type ReactNode } from 'react';
import type { Brand, Category } from '../api/catalog.js';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { QueryState } from '../lib/QueryState.js';

const validName = (name: string) => name.trim().length >= 2 && name.trim().length <= 120;

/** One name field and a button: adds a brand or a category. */
function AddForm({
  label,
  submitLabel,
  onAdd,
  children,
}: {
  readonly label: string;
  readonly submitLabel: string;
  readonly onAdd: (name: string) => Promise<unknown>;
  readonly children?: ReactNode;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const [name, setName] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const submit = async (event: SyntheticEvent) => {
    event.preventDefault();
    if (!validName(name)) {
      setMessage(t('catalogSetup.nameInvalid'));
      return;
    }
    setPending(true);
    setMessage(null);
    try {
      await onAdd(name.trim());
      setName('');
      toast({ title: t('catalogSetup.added'), tone: 'success' });
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="add-form"
      noValidate
      onSubmit={(event) => {
        void submit(event);
      }}
    >
      <Field label={label} error={message ?? undefined}>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      {children}
      <Button type="submit" variant="secondary" loading={pending}>
        {submitLabel}
      </Button>
    </form>
  );
}

function RenameDialog({
  current,
  onRename,
  onClose,
}: {
  readonly current: string;
  readonly onRename: (name: string) => Promise<unknown>;
  readonly onClose: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(current);
  return (
    <FormDialog
      open
      onClose={onClose}
      title={t('catalogSetup.rename', { name: current })}
      submitLabel={t('common.save')}
      onSubmit={async () => {
        if (!validName(name)) return t('catalogSetup.nameInvalid');
        await onRename(name.trim());
        return undefined;
      }}
    >
      <Field label={t('catalogSetup.name')}>
        <Input
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function Brands({ brands, manage }: { readonly brands: Brand[]; readonly manage: boolean }) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<Brand | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['brands'] });
  const toggle = async (brand: Brand) => {
    try {
      await api.catalog.updateBrand(brand.id, { isActive: !brand.isActive });
      await refresh();
      toast({ title: t('common.saved'), tone: 'success' });
    } catch (error) {
      toast({ title: errorMessage(error), tone: 'danger' });
    }
  };
  return (
    <Card title={t('catalogSetup.brands')}>
      <div className="stack">
        {brands.length === 0 ? (
          <p className="muted">{t('catalogSetup.noBrands')}</p>
        ) : (
          <ul className="record-list">
            {brands.map((brand) => (
              <li key={brand.id} className="record-list__row">
                <span className="record-list__title">
                  {brand.name}
                  {!brand.isActive && (
                    <>
                      {' '}
                      <Badge>{t('catalogSetup.inactive')}</Badge>
                    </>
                  )}
                </span>
                {manage && (
                  <span className="row">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('catalogSetup.rename', { name: brand.name })}
                      onClick={() => {
                        setRenaming(brand);
                      }}
                    >
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        void toggle(brand);
                      }}
                    >
                      {brand.isActive
                        ? t('catalogSetup.deactivate', { name: brand.name })
                        : t('catalogSetup.activate', { name: brand.name })}
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <AddForm
            label={t('catalogSetup.newBrand')}
            submitLabel={t('catalogSetup.addBrand')}
            onAdd={async (name) => {
              await api.catalog.createBrand(name);
              await refresh();
            }}
          />
        )}
      </div>
      {renaming !== null && (
        <RenameDialog
          current={renaming.name}
          onClose={() => {
            setRenaming(null);
          }}
          onRename={async (name) => {
            await api.catalog.updateBrand(renaming.id, { name });
            await refresh();
          }}
        />
      )}
    </Card>
  );
}

function Categories({
  categories,
  manage,
}: {
  readonly categories: Category[];
  readonly manage: boolean;
}) {
  const api = useApi();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [parentId, setParentId] = useState('');
  const [renaming, setRenaming] = useState<Category | null>(null);
  const names = new Map(categories.map((category) => [category.id, category.name]));
  const topLevel = categories.filter((category) => category.parentId === null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['categories'] });
  return (
    <Card title={t('catalogSetup.categories')}>
      <div className="stack">
        {categories.length === 0 ? (
          <p className="muted">{t('catalogSetup.noCategories')}</p>
        ) : (
          <ul className="record-list">
            {categories.map((category) => (
              <li key={category.id} className="record-list__row">
                <span className="record-list__title">
                  {category.parentId === null
                    ? category.name
                    : `${String(names.get(category.parentId))} › ${category.name}`}
                </span>
                {manage && (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('catalogSetup.rename', { name: category.name })}
                    onClick={() => {
                      setRenaming(category);
                    }}
                  >
                    {t('common.edit')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {manage && (
          <AddForm
            label={t('catalogSetup.newCategory')}
            submitLabel={t('catalogSetup.addCategory')}
            onAdd={async (name) => {
              await api.catalog.createCategory({
                name,
                ...(parentId === '' ? {} : { parentId }),
              });
              await refresh();
            }}
          >
            <Field label={t('catalogSetup.parent')}>
              <Select
                value={parentId}
                onChange={(event) => {
                  setParentId(event.target.value);
                }}
              >
                <option value="">{t('catalogSetup.noParent')}</option>
                {/* One level of subcategories: only top-level categories can hold others. */}
                {topLevel.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          </AddForm>
        )}
      </div>
      {renaming !== null && (
        <RenameDialog
          current={renaming.name}
          onClose={() => {
            setRenaming(null);
          }}
          onRename={async (name) => {
            await api.catalog.renameCategory(renaming.id, name);
            await refresh();
          }}
        />
      )}
    </Card>
  );
}

/** /products/setup — brands and categories. */
export function CatalogSetupPage() {
  const api = useApi();
  const { t } = useI18n();
  const can = usePermissions();
  const manage = can('catalog:manage');
  const brands = useQuery({ queryKey: ['brands'], queryFn: () => api.catalog.brands() });
  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.catalog.categories(),
  });
  return (
    <>
      <PageHeader title={t('catalogSetup.title')} description={t('catalogSetup.description')} />
      <div className="detail-grid">
        <QueryState query={brands} error="catalogSetup.error">
          {(list) => <Brands brands={list} manage={manage} />}
        </QueryState>
        <QueryState query={categories} error="catalogSetup.error">
          {(list) => <Categories categories={list} manage={manage} />}
        </QueryState>
      </div>
    </>
  );
}
