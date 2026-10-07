import {
  COLOR_MODES,
  DENSITIES,
  FONT_KEYS,
  FONTS,
  PALETTE_STEPS,
  normalizeHex,
  RADIUS_SCALES,
  STATUSES,
  validateBranding,
  type Branding,
  type ThemeAdjustment,
} from '@paint/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Field,
  Input,
  PageHeader,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useTheme,
  useToast,
} from '@paint/ui';
import { useEffect, useState } from 'react';
import { errorMessage } from '../api/errors.js';
import { useI18n } from '../i18n/i18n.js';
import { useBranding } from '../theme/BrandingProvider.js';
import { IdentitySettings } from './IdentitySettings.js';

type Draft = { -readonly [K in keyof Branding]: string };

function ColorField({
  label,
  value,
  error,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly error: string | undefined;
  readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  // The picker needs a full hex value: keep showing the last good one while a code is typed.
  const [lastValid, setLastValid] = useState(value);
  const change = (next: string) => {
    const hex = normalizeHex(next);
    if (hex !== null) setLastValid(hex);
    onChange(next);
  };
  return (
    <Field label={label} hint={t('appearance.colorHint')} error={error}>
      <div className="color-field">
        <input
          type="color"
          className="color-field__swatch"
          aria-label={t('appearance.picker', { label })}
          value={normalizeHex(value) ?? lastValid}
          onChange={(event) => {
            change(event.target.value);
          }}
        />
        <Input
          value={value}
          spellCheck={false}
          onChange={(event) => {
            change(event.target.value.trim());
          }}
        />
      </div>
    </Field>
  );
}

function Preview() {
  const { t } = useI18n();
  return (
    <Card title={t('appearance.preview')} className="appearance__preview">
      <div className="stack">
        <p className="muted">{t('appearance.previewDescription')}</p>
        <div className="row">
          <Button>{t('appearance.sampleButton')}</Button>
          <Button variant="secondary">{t('appearance.sampleSecondary')}</Button>
        </div>
        <Field label={t('appearance.sampleInput')}>
          <Input placeholder={t('appearance.samplePlaceholder')} />
        </Field>
        <Tabs defaultValue="a">
          <TabsList aria-label={t('appearance.preview')}>
            <TabsTrigger value="a">{t('nav.dashboard')}</TabsTrigger>
            <TabsTrigger value="b">{t('nav.stock')}</TabsTrigger>
          </TabsList>
          <TabsContent value="a">
            <p>
              <a href="#preview">{t('nav.customers')}</a>
            </p>
          </TabsContent>
          <TabsContent value="b">{t('nav.products')}</TabsContent>
        </Tabs>
        <div className="row" aria-label={t('appearance.sampleBadges')} role="group">
          <Badge tone="primary">{t('nav.leads')}</Badge>
          {STATUSES.map((status) => (
            <Badge key={status} tone={status}>
              {t(`status.${status}`)}
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  );
}

function Palette() {
  const { t } = useI18n();
  const { theme } = useTheme();
  return (
    <Card title={t('appearance.palette')}>
      <div className="palette">
        {(['primary', 'accent', 'neutral'] as const).map((ramp) => (
          <div key={ramp} className="palette__ramp" role="list" aria-label={ramp}>
            {PALETTE_STEPS.map((step) => (
              <span
                key={step}
                role="listitem"
                className="palette__swatch"
                title={`${ramp} ${String(step)}: ${theme.palette[ramp][step]}`}
                style={{ background: `var(--palette-${ramp}-${String(step)})` }}
              />
            ))}
          </div>
        ))}
      </div>
    </Card>
  );
}

function Readability() {
  const { t } = useI18n();
  const { theme } = useTheme();
  const failing = theme.checks.filter((check) => !check.passes);
  return (
    <Card title={t('appearance.readability')}>
      <div className="stack">
        {failing.length === 0 && <Alert tone="success">{t('appearance.readabilityOk')}</Alert>}
        {theme.adjustments.length > 0 && (
          <div>
            <p>{t('appearance.adjusted')}</p>
            <ul className="adjustments">
              {theme.adjustments.map((change) => (
                <li key={`${change.mode}-${change.token}`}>
                  <span className="adjustments__swatches" aria-hidden="true">
                    <span className="palette__swatch" style={{ background: change.from }} />
                    <span className="palette__swatch" style={{ background: change.to }} />
                  </span>
                  {change.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** What the server answered to the last save: the readability adjustments it made. */
function SavedAdjustments({ adjustments }: { readonly adjustments: readonly ThemeAdjustment[] }) {
  const { t } = useI18n();
  return (
    <Alert tone="success" title={t('appearance.savedForEveryone')}>
      {adjustments.length === 0 ? (
        <p>{t('appearance.serverReadable')}</p>
      ) : (
        <>
          <p>{t('appearance.serverAdjusted')}</p>
          <ul className="adjustments">
            {adjustments.map((change) => (
              <li key={`${change.mode}-${change.token}`}>{change.reason}</li>
            ))}
          </ul>
        </>
      )}
    </Alert>
  );
}

/**
 * The theme playground: change the brand colours, corners, spacing and font
 * and the whole app follows at once. Saving keeps it for everyone in the
 * business; leaving without saving drops it.
 */
export function AppearancePage() {
  const { saved } = useBranding();
  const [adjustments, setAdjustments] = useState<ThemeAdjustment[] | null>(null);
  // A fresh form whenever the saved branding changes (it loads, or is saved).
  return (
    <AppearanceEditor
      key={JSON.stringify(saved)}
      serverAdjustments={adjustments}
      onSaved={setAdjustments}
    />
  );
}

function AppearanceEditor({
  serverAdjustments,
  onSaved,
}: {
  readonly serverAdjustments: readonly ThemeAdjustment[] | null;
  readonly onSaved: (adjustments: ThemeAdjustment[] | null) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { saved, preview, save, reset } = useBranding();
  const [draft, setDraft] = useState<Draft>({ ...saved });
  const failed = (error: unknown) => {
    toast({ title: errorMessage(error), tone: 'danger' });
  };
  const result = validateBranding(draft);
  const errors = new Map(
    result.ok ? [] : result.issues.map((issue) => [issue.path, issue.message]),
  );
  const valid = result.ok ? result.branding : null;

  // Leaving the page without saving goes back to the saved look.
  useEffect(
    () => () => {
      preview(null);
    },
    [preview],
  );

  /** Every valid change restyles the whole app at once. */
  const set = (field: keyof Draft) => (value: string) => {
    const next = { ...draft, [field]: value };
    setDraft(next);
    onSaved(null);
    const checked = validateBranding(next);
    if (checked.ok) preview(checked.branding);
  };

  return (
    <>
      <PageHeader title={t('appearance.title')} description={t('appearance.description')} />
      <IdentitySettings />
      <div className="appearance">
        <Card>
          <form
            className="stack"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!valid) return;
              void save(valid).then((adjustments) => {
                onSaved(adjustments);
                toast({ title: t('appearance.saved'), tone: 'success' });
              }, failed);
            }}
          >
            <Field label={t('appearance.appName')} error={errors.get('appName')}>
              <Input
                value={draft.appName}
                onChange={(event) => {
                  set('appName')(event.target.value);
                }}
              />
            </Field>
            <ColorField
              label={t('appearance.primary')}
              value={draft.primary}
              error={errors.get('primary')}
              onChange={set('primary')}
            />
            <ColorField
              label={t('appearance.accent')}
              value={draft.accent}
              error={errors.get('accent')}
              onChange={set('accent')}
            />
            <Field label={t('appearance.mode')}>
              <Select
                value={draft.mode}
                onChange={(event) => {
                  set('mode')(event.target.value);
                }}
              >
                {COLOR_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`appearance.modes.${mode}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('appearance.radius')}>
              <Select
                value={draft.radius}
                onChange={(event) => {
                  set('radius')(event.target.value);
                }}
              >
                {RADIUS_SCALES.map((radius) => (
                  <option key={radius} value={radius}>
                    {t(`appearance.radii.${radius}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('appearance.density')}>
              <Select
                value={draft.density}
                onChange={(event) => {
                  set('density')(event.target.value);
                }}
              >
                {DENSITIES.map((density) => (
                  <option key={density} value={density}>
                    {t(`appearance.densities.${density}`)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('appearance.font')}>
              <Select
                value={draft.font}
                onChange={(event) => {
                  set('font')(event.target.value);
                }}
              >
                {FONT_KEYS.map((font) => (
                  <option key={font} value={font}>
                    {font === 'system' ? t('appearance.systemFont') : FONTS[font].label}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="row">
              <Button type="submit" disabled={!valid}>
                {t('appearance.save')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  void reset().then((branding) => {
                    setDraft({ ...branding });
                    onSaved(null);
                    toast({ title: t('appearance.resetDone'), tone: 'info' });
                  }, failed);
                }}
              >
                {t('appearance.reset')}
              </Button>
            </div>
          </form>
        </Card>
        <div className="stack">
          {serverAdjustments !== null && <SavedAdjustments adjustments={serverAdjustments} />}
          <Preview />
          <Readability />
          <Palette />
        </div>
      </div>
    </>
  );
}
