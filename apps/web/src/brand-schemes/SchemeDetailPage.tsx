import { variantTitle, type BrandClaimView, type SchemeDetail } from '@paint/shared';
import { Alert, Badge, Button, Card, PageHeader, Table, buttonStyle, useToast } from '@paint/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { errorMessage } from '../api/errors.js';
import { useApi } from '../app/services.js';
import { usePermissions } from '../auth/session.js';
import { useI18n } from '../i18n/i18n.js';
import { QueryState } from '../lib/QueryState.js';
import { ClaimDialog, ClaimStatusDialog, EndDialog, ReceiptDialog } from './scheme-dialogs.js';
import { SchemeProgressBar, SchemeStatusBadge, schemesKey, useSchemeText } from './scheme-parts.js';

type Open =
  | { readonly kind: 'receipt' }
  | { readonly kind: 'claim' }
  | { readonly kind: 'status'; readonly claim: BrandClaimView }
  | { readonly kind: 'close' }
  | { readonly kind: 'cancel' };

function Progress({ detail }: { readonly detail: SchemeDetail }) {
  const { t, number, money } = useI18n();
  const { amount, nextSlab, benefit } = useSchemeText();
  const { scheme, progress } = detail;
  return (
    <Card title={t('schemes.detail.progress')}>
      <div className="stack">
        <SchemeProgressBar scheme={scheme} progress={progress} />
        <p>{nextSlab(scheme, progress)}</p>
        <dl className="scheme-figures">
          <div>
            <dt className="muted">{t('schemes.detail.value')}</dt>
            <dd>{money(progress.achievedValuePaise)}</dd>
          </div>
          <div>
            <dt className="muted">{t('schemes.detail.litres')}</dt>
            <dd>
              {t('schemes.detail.litresWithFree', {
                litres: amount('litres', progress.achievedMillilitres),
                free: amount('litres', progress.freeMillilitres),
              })}
            </dd>
          </div>
          <div>
            <dt className="muted">{t('schemes.detail.slabReached')}</dt>
            <dd>
              {progress.current === null
                ? t('schemes.detail.noSlab')
                : number(progress.current.index + 1)}
            </dd>
          </div>
          <div>
            <dt className="muted">{t('schemes.detail.daysLeft')}</dt>
            <dd>{number(progress.remainingDays)}</dd>
          </div>
          <div>
            <dt className="muted">{t('schemes.detail.projected')}</dt>
            <dd>
              {amount(scheme.measure, progress.projected)}
              {progress.projectedSlab !== null &&
                ` · ${t('schemes.detail.projectedSlab', { slab: number(progress.projectedSlab.index + 1) })}`}
            </dd>
          </div>
        </dl>
        <Table label={t('schemes.detail.slabs')}>
          <thead>
            <tr>
              <th scope="col">{t('schemes.detail.slab')}</th>
              <th scope="col">{t('schemes.detail.target')}</th>
              <th scope="col">{t('schemes.detail.gives')}</th>
              <th scope="col">{t('schemes.detail.reached')}</th>
            </tr>
          </thead>
          <tbody>
            {scheme.slabs.map((slab, index) => (
              <tr key={slab.id}>
                <th scope="row">{number(slab.position)}</th>
                <td>{amount(scheme.measure, slab.target)}</td>
                <td>{slab.benefits.map(benefit).join(' · ')}</td>
                <td>
                  {progress.current !== null && index <= progress.current.index ? (
                    <Badge tone="success">{t('schemes.detail.yes')}</Badge>
                  ) : (
                    t('schemes.detail.no')
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

function Benefits({ detail }: { readonly detail: SchemeDetail }) {
  const { t, money, number, date, label } = useI18n();
  const { claim } = detail;
  // Every pack owed or received is named by a slab's benefit or by what came.
  const packs = new Map<string, string>([
    ...detail.scheme.slabs.flatMap((slab) =>
      slab.benefits.flatMap((item): [string, string][] =>
        item.kind === 'free_goods' ? [[item.variantId, String(item.variantTitle)]] : [],
      ),
    ),
    ...detail.receipts.flatMap((receipt): [string, string][] =>
      receipt.variant === null ? [] : [[receipt.variant.id, receipt.variant.title]],
    ),
  ]);
  return (
    <Card title={t('schemes.detail.benefits')}>
      <div className="stack">
        {!claim.final && <Alert tone="info">{t('schemes.detail.provisional')}</Alert>}
        <p>
          <Badge
            tone={
              claim.status === 'open' ? 'warning' : claim.status === 'excess' ? 'info' : 'success'
            }
          >
            {label('schemeClaimStatus', claim.status)}
          </Badge>{' '}
          {t('schemes.detail.due', { date: date(claim.dueOn) })}
          {claim.bucket !== null && ` · ${label('ageingBuckets', claim.bucket)}`}
        </p>
        <Table label={t('schemes.detail.expectedVsReceived')}>
          <thead>
            <tr>
              <th scope="col">{t('schemes.detail.benefit')}</th>
              <th scope="col">{t('schemes.detail.expected')}</th>
              <th scope="col">{t('schemes.detail.received')}</th>
              <th scope="col">{t('schemes.detail.outstanding')}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">{t('schemes.detail.money')}</th>
              <td>{money(claim.money.expectedPaise)}</td>
              <td>{money(claim.money.receivedPaise)}</td>
              <td>{money(claim.money.outstandingPaise)}</td>
            </tr>
            {claim.freeGoods.map((row) => (
              <tr key={row.variantId}>
                <th scope="row">{String(packs.get(row.variantId))}</th>
                <td>{number(row.expectedUnits)}</td>
                <td>{number(row.receivedUnits)}</td>
                <td>{number(row.outstandingUnits)}</td>
              </tr>
            ))}
            {claim.points.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td>{number(row.expected)}</td>
                <td>{number(row.received)}</td>
                <td>{number(row.outstanding)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </Card>
  );
}

function Receipts({ detail }: { readonly detail: SchemeDetail }) {
  const { t, money, number, date, label } = useI18n();
  return (
    <Card title={t('schemes.detail.receipts')}>
      {detail.receipts.length === 0 ? (
        <p className="muted">{t('schemes.detail.noReceipts')}</p>
      ) : (
        <Table label={t('schemes.detail.receipts')}>
          <thead>
            <tr>
              <th scope="col">{t('schemes.detail.date')}</th>
              <th scope="col">{t('schemes.detail.what')}</th>
              <th scope="col">{t('schemes.detail.reference')}</th>
              <th scope="col">{t('schemes.detail.recordedBy')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.receipts.map((receipt) => (
              <tr key={receipt.id}>
                <td>{date(receipt.receivedOn)}</td>
                <td>
                  {receipt.kind === 'money'
                    ? `${money(Number(receipt.amountPaise))} · ${label('schemeMoneyForm', String(receipt.moneyForm))}`
                    : receipt.kind === 'free_goods'
                      ? `${number(Number(receipt.units))} × ${String(receipt.variant?.title)}`
                      : `${number(Number(receipt.points))} · ${String(receipt.label)}`}
                  {receipt.note !== null && <span className="muted"> · {receipt.note}</span>}
                </td>
                <td>
                  {[receipt.reference, receipt.claim?.number].filter(Boolean).join(' · ') ||
                    t('common.none')}
                </td>
                <td>{receipt.recordedBy}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Claims({
  detail,
  manage,
  onUpdate,
}: {
  readonly detail: SchemeDetail;
  readonly manage: boolean;
  readonly onUpdate: (claim: BrandClaimView) => void;
}) {
  const { t, money, date, label } = useI18n();
  return (
    <Card title={t('schemes.detail.claims')}>
      {detail.claims.length === 0 ? (
        <p className="muted">{t('schemes.detail.noClaims')}</p>
      ) : (
        <Table label={t('schemes.detail.claims')}>
          <thead>
            <tr>
              <th scope="col">{t('schemes.detail.claim')}</th>
              <th scope="col">{t('schemes.detail.filedOn')}</th>
              <th scope="col">{t('schemes.detail.claimed')}</th>
              <th scope="col">{t('schemes.detail.status')}</th>
              {manage && <th scope="col">{t('schemes.detail.followUp')}</th>}
            </tr>
          </thead>
          <tbody>
            {detail.claims.map((claim) => (
              <tr key={claim.id}>
                <th scope="row">
                  {claim.number}
                  {claim.brandReference !== null && (
                    <span className="muted"> · {claim.brandReference}</span>
                  )}
                </th>
                <td>{date(claim.filedOn)}</td>
                <td>{money(claim.claimedPaise)}</td>
                <td>{label('brandClaimStatus', claim.status)}</td>
                {manage && (
                  <td>
                    {(claim.status === 'filed' || claim.status === 'acknowledged') && (
                      <Button
                        variant="ghost"
                        aria-label={t('schemes.claim.updateTitle', { number: claim.number })}
                        onClick={() => {
                          onUpdate(claim);
                        }}
                      >
                        {t('schemes.detail.update')}
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function GrnLines({ detail }: { readonly detail: SchemeDetail }) {
  const { t, money, number, date } = useI18n();
  const { amount } = useSchemeText();
  return (
    <Card title={t('schemes.detail.grns')}>
      {detail.grnLines.length === 0 ? (
        <p className="muted">{t('schemes.detail.noGrns')}</p>
      ) : (
        <Table label={t('schemes.detail.grns')}>
          <thead>
            <tr>
              <th scope="col">{t('schemes.detail.grn')}</th>
              <th scope="col">{t('schemes.detail.countedOn')}</th>
              <th scope="col">{t('schemes.detail.pack')}</th>
              <th scope="col">{t('schemes.detail.quantity')}</th>
              <th scope="col">{t('schemes.detail.value')}</th>
              <th scope="col">{t('schemes.detail.litres')}</th>
            </tr>
          </thead>
          <tbody>
            {detail.grnLines.map((line, index) => (
              <tr key={`${line.sourceId}:${line.variantId}:${String(index)}`}>
                <th scope="row">
                  {line.kind === 'return'
                    ? t('schemes.detail.return', { number: line.number })
                    : line.number}
                  <span className="muted"> · {line.store.code}</span>
                </th>
                <td>{date(line.countedOn)}</td>
                <td>
                  {line.productName} <span className="muted">{line.sku}</span>
                </td>
                <td>
                  {number(line.quantity)}
                  {line.freeQuantity > 0 &&
                    ` + ${t('schemes.detail.free', { units: number(line.freeQuantity) })}`}
                </td>
                <td>{money(line.valuePaise)}</td>
                <td>{amount('litres', line.millilitres + line.freeMillilitres)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

function Actions({
  detail,
  onOpen,
}: {
  readonly detail: SchemeDetail;
  readonly onOpen: (open: Open) => void;
}) {
  const api = useApi();
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const { status, id } = detail.scheme;
  const running = status === 'draft' || status === 'active';
  const counted = status === 'active' || status === 'closed';
  return (
    <div className="row">
      {running && (
        <Link to={`/brand-schemes/${id}/edit`} {...buttonStyle('secondary')}>
          {t('common.edit')}
        </Link>
      )}
      {status === 'draft' && (
        <Button
          loading={busy}
          onClick={() => {
            setBusy(true);
            api.schemes
              .activate(id)
              .then(() => queryClient.invalidateQueries({ queryKey: schemesKey }))
              .then(() => {
                toast({ title: t('schemes.detail.activated'), tone: 'success' });
              })
              .catch((error: unknown) => {
                toast({ title: errorMessage(error), tone: 'danger' });
              })
              .finally(() => {
                setBusy(false);
              });
          }}
        >
          {t('schemes.detail.activate')}
        </Button>
      )}
      {counted && (
        <>
          <Button
            onClick={() => {
              onOpen({ kind: 'receipt' });
            }}
          >
            {t('schemes.receipt.title')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              onOpen({ kind: 'claim' });
            }}
          >
            {t('schemes.claim.title')}
          </Button>
        </>
      )}
      {status === 'active' && (
        <Button
          variant="secondary"
          onClick={() => {
            onOpen({ kind: 'close' });
          }}
        >
          {t('schemes.end.close')}
        </Button>
      )}
      {running && (
        <Button
          variant="ghost"
          onClick={() => {
            onOpen({ kind: 'cancel' });
          }}
        >
          {t('schemes.end.cancel')}
        </Button>
      )}
    </div>
  );
}

function Detail({ detail }: { readonly detail: SchemeDetail }) {
  const api = useApi();
  const { t, date, label } = useI18n();
  const manage = usePermissions()('schemes:manage');
  const [open, setOpen] = useState<Open | null>(null);
  const { scheme } = detail;
  const products = useQuery({
    queryKey: ['products', { brandId: scheme.brand.id, limit: 200 }],
    queryFn: ({ signal }) => api.catalog.products({ brandId: scheme.brand.id, limit: 200 }, signal),
    enabled: manage,
  });
  const packs = (products.data?.items ?? []).flatMap((product) =>
    product.variants.map((variant) => ({
      id: variant.id,
      title: variantTitle(product.brand.name, product.name, variant),
    })),
  );
  const close = () => {
    setOpen(null);
  };
  return (
    <>
      <PageHeader
        title={`${scheme.brand.name} · ${scheme.name}`}
        description={[
          t('schemes.period', { from: date(scheme.startsOn), to: date(scheme.endsOn) }),
          label('schemeMeasure', scheme.measure),
          label('schemeMode', scheme.mode),
          label('schemeDateBasis', scheme.dateBasis),
          scheme.brandReference,
        ]
          .filter(Boolean)
          .join(' · ')}
        actions={manage ? <Actions detail={detail} onOpen={setOpen} /> : undefined}
      />
      <div className="stack">
        <p>
          <SchemeStatusBadge status={scheme.status} />
          {scheme.endNote !== null && <span className="muted"> · {scheme.endNote}</span>}
          {scheme.note !== null && <span className="muted"> · {scheme.note}</span>}
        </p>
        <div className="detail-grid">
          <Progress detail={detail} />
          <Benefits detail={detail} />
        </div>
        <Receipts detail={detail} />
        <Claims
          detail={detail}
          manage={manage}
          onUpdate={(claim) => {
            setOpen({ kind: 'status', claim });
          }}
        />
        <GrnLines detail={detail} />
      </div>
      {open?.kind === 'receipt' && <ReceiptDialog detail={detail} packs={packs} onClose={close} />}
      {open?.kind === 'claim' && <ClaimDialog detail={detail} onClose={close} />}
      {open?.kind === 'status' && <ClaimStatusDialog claim={open.claim} onClose={close} />}
      {(open?.kind === 'close' || open?.kind === 'cancel') && (
        <EndDialog detail={detail} action={open.kind} onClose={close} />
      )}
    </>
  );
}

/**
 * /brand-schemes/:id — a scheme's progress from the GRNs it counted, its slabs, what
 * the brand owes against what it issued, and the claims filed with the brand.
 */
export function SchemeDetailPage() {
  const api = useApi();
  const { id = '' } = useParams();
  const detail = useQuery({
    queryKey: [...schemesKey, id],
    queryFn: ({ signal }) => api.schemes.detail(id, signal),
  });
  return (
    <QueryState query={detail} error="schemes.detailError">
      {(data) => <Detail detail={data} />}
    </QueryState>
  );
}
