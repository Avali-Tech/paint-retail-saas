import {
  signInPath,
  validateSlug,
  type LogoUploadErrorCode,
  type SlugProblem,
} from '@paint/shared';
import { Alert, Button, Card, Field, Input, useToast } from '@paint/ui';
import { useState } from 'react';
import { errorDetail, errorMessage } from '../api/errors.js';
import type { OrganizationIdentity } from '../api/types.js';
import { useServices } from '../app/services.js';
import { useI18n } from '../i18n/i18n.js';
import { useIdentity } from '../theme/IdentityProvider.js';
import '../theme/brand.css';

// The API's logo rules (apps/api/src/branding/logo-checks.ts), checked before sending
// where the browser can tell; the API checks the bytes again.
export const MAX_LOGO_BYTES = 1024 * 1024;
const ACCEPTED_LOGOS = 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp';

const LOGO_PROBLEMS: readonly LogoUploadErrorCode[] = [
  'empty_file',
  'file_type',
  'svg_not_allowed',
  'too_large',
  'dimensions',
  'scanner_unavailable',
  'storage_unavailable',
  'virus_found',
];

/** What is wrong with a logo before uploading it, or null to let the API judge it. */
export function logoProblem(file: File): LogoUploadErrorCode | null {
  if (file.size === 0) return 'empty_file';
  if (file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')) {
    return 'svg_not_allowed';
  }
  return file.size > MAX_LOGO_BYTES ? 'too_large' : null;
}

/** The refusal's code from the API, when it is one the app explains. */
function refusalOf(error: unknown): LogoUploadErrorCode | null {
  const code = errorDetail(error, 'code');
  return LOGO_PROBLEMS.find((problem) => problem === code) ?? null;
}

function LogoCard({ identity }: { readonly identity: OrganizationIdentity }) {
  const { t } = useI18n();
  const toast = useToast();
  const services = useServices();
  const { setIdentity, assetUrl } = useIdentity();
  const [file, setFile] = useState<File | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const src = identity.logo === null ? null : assetUrl(identity.logo.url);

  const run = async (work: () => Promise<OrganizationIdentity>, done: string) => {
    setBusy(true);
    setProblem(null);
    try {
      setIdentity(await work());
      setFile(null);
      toast({ title: done, tone: 'success' });
    } catch (error) {
      const code = refusalOf(error);
      setProblem(
        code === null
          ? errorMessage(error)
          : t(`branding.logo.problems.${code}`, { detail: errorMessage(error) }),
      );
    } finally {
      setBusy(false);
    }
  };

  const upload = () => {
    if (file === null) {
      setProblem(t('branding.logo.problems.noFile'));
      return;
    }
    const early = logoProblem(file);
    if (early !== null) {
      setProblem(t(`branding.logo.problems.${early}`, { detail: '' }));
      return;
    }
    void run(() => services.identity.uploadLogo(file), t('branding.logo.uploaded'));
  };

  return (
    <Card title={t('branding.logo.title')}>
      <div className="stack">
        <p className="muted">{t('branding.logo.description')}</p>
        {src === null ? (
          <p>{t('branding.logo.none')}</p>
        ) : (
          <div className="logo-previews" role="group" aria-label={t('branding.logo.previews')}>
            <figure className="logo-preview logo-preview--light">
              <img src={src} alt="" />
              <figcaption>{t('branding.logo.onLight')}</figcaption>
            </figure>
            <figure className="logo-preview logo-preview--dark">
              <img src={src} alt="" />
              <figcaption>{t('branding.logo.onDark')}</figcaption>
            </figure>
          </div>
        )}
        {problem !== null && <Alert tone="danger">{problem}</Alert>}
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            upload();
          }}
        >
          <Field label={t('branding.logo.file')} hint={t('branding.logo.fileHint')}>
            <Input
              type="file"
              accept={ACCEPTED_LOGOS}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setProblem(null);
              }}
            />
          </Field>
          <div className="row">
            <Button type="submit" loading={busy}>
              {t('branding.logo.upload')}
            </Button>
            {identity.logo !== null && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  void run(() => services.identity.removeLogo(), t('branding.logo.removed'));
                }}
              >
                {t('branding.logo.remove')}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
}

type LinkProblem = SlugProblem | 'taken';

function SignInLinkCard({ identity }: { readonly identity: OrganizationIdentity }) {
  const { t } = useI18n();
  const toast = useToast();
  const services = useServices();
  const { setIdentity } = useIdentity();
  const [slug, setSlug] = useState(identity.slug);
  const [problem, setProblem] = useState<LinkProblem | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const link = `${window.location.origin}${signInPath(identity.slug)}`;

  const save = async () => {
    const checked = validateSlug(slug);
    setFailure(null);
    if (!checked.ok) {
      setProblem(checked.problem);
      return;
    }
    setProblem(null);
    setSaving(true);
    try {
      const saved = await services.identity.saveSlug(checked.slug);
      setIdentity(saved);
      setSlug(saved.slug);
      toast({ title: t('branding.link.saved'), tone: 'success' });
    } catch (error) {
      // The name was checked before sending; the server can still find it taken.
      if (errorDetail(error, 'code') === 'taken') setProblem('taken');
      else setFailure(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast({ title: t('branding.link.copied'), tone: 'success' });
    } catch {
      toast({ title: t('branding.link.copyFailed'), tone: 'danger' });
    }
  };

  return (
    <Card title={t('branding.link.title')}>
      <div className="stack">
        <p className="muted">{t('branding.link.description')}</p>
        <Field label={t('branding.link.address')}>
          <div className="sign-in-link">
            <Input
              readOnly
              value={link}
              onFocus={(event) => {
                event.target.select();
              }}
            />
            <Button
              variant="secondary"
              onClick={() => {
                void copy();
              }}
            >
              {t('branding.link.copy')}
            </Button>
          </div>
        </Field>
        {failure !== null && <Alert tone="danger">{failure}</Alert>}
        <form
          className="stack"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field
            label={t('branding.link.slug')}
            hint={t('branding.link.slugHint')}
            error={problem === null ? undefined : t(`branding.link.problems.${problem}`)}
          >
            <Input
              value={slug}
              spellCheck={false}
              autoCapitalize="none"
              onChange={(event) => {
                setSlug(event.target.value);
                setProblem(null);
              }}
            />
          </Field>
          <div className="row">
            <Button type="submit" loading={saving}>
              {t('branding.link.save')}
            </Button>
          </div>
        </form>
      </div>
    </Card>
  );
}

/**
 * Settings → Appearance: the business's logo (header, sign-in page, browser icon)
 * and its sign-in link name, with the link to copy and share.
 */
export function IdentitySettings() {
  const { t } = useI18n();
  const { identity } = useIdentity();
  if (identity === null) return <p className="muted">{t('branding.loading')}</p>;
  return (
    <div className="identity-settings">
      <LogoCard identity={identity} />
      <SignInLinkCard key={identity.slug} identity={identity} />
    </div>
  );
}
