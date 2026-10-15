import type { SiteAccountStatus, SiteAccountView } from '@paint/shared';
import {
  Badge,
  Button,
  Field,
  Input,
  Select,
  Table,
  Textarea,
  useToast,
  type Tone,
} from '@paint/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { FormDialog } from '../lib/FormDialog.js';
import { parseRupees } from '../lib/inputs.js';
/** Up to ₹10 crore, as the API allows (and a party's own limit). */
const MAX_LIMIT_PAISE = 10_000_000_000;

export const SITE_TONE: Record<SiteAccountStatus, Tone> = {
  active: 'success',
  on_hold: 'danger',
  closed: 'neutral',
};

/** A project the party is on, to open a site account for. */
export interface SiteProject {
  readonly id: string;
  readonly number: string;
  readonly name: string;
}

/** A site limit typed in rupees, checked against the party's own limit. */
export function readSiteLimit(text: string, partyLimitPaise: number): number | 'invalid' | 'over' {
  const paise = parseRupees(text);
  if (paise === null || paise <= 0 || paise > MAX_LIMIT_PAISE) return 'invalid';
  return paise > partyLimitPaise ? 'over' : paise;
}

/**
 * The party's site (job) accounts on its credit panel (MVP 3 spec §3.3): each
 * site's limit, what it owes and its status, and "Add site account" for approvers.
 */
export function SiteAccountsSection({
  partyId,
  partyLimitPaise,
  sites,
  projects,
}: {
  readonly partyId: string;
  readonly partyLimitPaise: number;
  readonly sites: readonly SiteAccountView[];
  readonly projects: readonly SiteProject[];
}) {
  const api = useApi();
  const { t, money, label, number } = useI18n();
  const can = usePermissions();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const free = projects.filter((project) => !sites.some((site) => site.project.id === project.id));
  const [projectId, setProjectId] = useState('');
  const [limit, setLimit] = useState('');
  const [notes, setNotes] = useState('');
  const open = () => {
    // "Add site account" shows only while some project has no account yet.
    const [first] = free as [SiteProject];
    setProjectId(first.id);
    setLimit('');
    setNotes('');
    setAdding(true);
  };
  return (
    <section className="stack" aria-label={t('sites.title')}>
      <h3>{t('sites.title')}</h3>
      {sites.length === 0 ? (
        <p className="muted">{t('sites.none')}</p>
      ) : (
        <Table label={t('sites.title')}>
          <thead>
            <tr>
              <th scope="col">{t('sites.site')}</th>
              <th scope="col">{t('sites.limit')}</th>
              <th scope="col">{t('sites.owes')}</th>
              <th scope="col">{t('sites.used')}</th>
              <th scope="col">{t('sites.status')}</th>
            </tr>
          </thead>
          <tbody>
            {sites.map((site) => (
              <tr key={site.id}>
                <th scope="row">
                  <Link to={`/site-accounts/${site.id}`}>{site.project.name}</Link>
                  <span className="cell-meta">{site.project.number}</span>
                </th>
                <td>{money(site.limitPaise)}</td>
                <td>{money(site.exposurePaise)}</td>
                <td>{t('credit.percent', { value: number(Number(site.utilizationPercent)) })}</td>
                <td>
                  <Badge tone={SITE_TONE[site.status]}>
                    {label('siteAccountStatus', site.status)}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {can('credit:approve') && free.length > 0 && (
        <div className="row">
          <Button variant="secondary" onClick={open}>
            {t('sites.add')}
          </Button>
        </div>
      )}
      <FormDialog
        open={adding}
        onClose={() => {
          setAdding(false);
        }}
        title={t('sites.addTitle')}
        description={t('sites.addHint', { limit: money(partyLimitPaise) })}
        submitLabel={t('sites.add')}
        onSubmit={async () => {
          const read = readSiteLimit(limit, partyLimitPaise);
          if (read === 'invalid') return t('sites.limitInvalid');
          if (read === 'over') return t('sites.limitOver', { limit: money(partyLimitPaise) });
          const note = notes.trim();
          await api.credit.addSite(partyId, {
            projectId,
            limitPaise: read,
            ...(note === '' ? {} : { notes: note }),
          });
          await queryClient.invalidateQueries({ queryKey: ['party'] });
          toast({ title: t('sites.added'), tone: 'success' });
          return undefined;
        }}
      >
        <Field label={t('sites.project')}>
          <Select
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value);
            }}
          >
            {free.map((project) => (
              <option key={project.id} value={project.id}>
                {`${project.number} · ${project.name}`}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('sites.limitLabel')}>
          <Input
            inputMode="decimal"
            value={limit}
            onChange={(event) => {
              setLimit(event.target.value);
            }}
          />
        </Field>
        <Field label={t('sites.notes')}>
          <Textarea
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value);
            }}
          />
        </Field>
      </FormDialog>
    </section>
  );
}
