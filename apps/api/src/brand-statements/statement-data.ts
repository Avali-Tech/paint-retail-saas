import { schema, type Transaction } from '@paint/db';
import {
  lineStatus,
  matchStatement,
  statementSummary,
  type AutoMatch,
  type BrandStatementDetail,
  type BrandStatementSummaryView,
  type OurRecordView,
  type StatementGrnBasis,
  type StatementLineView,
  type StatementTolerance,
} from '@paint/shared';
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';

/**
 * Loading a statement and our side of it (P2-M34): the supplier's GRNs and the brand's
 * scheme money around its period, how each line was settled, and the matching run that
 * keeps the automatic pairs up to date.
 */

const {
  brandBenefitReceipts,
  brandSchemes,
  brandStatementLines,
  brandStatementMatches,
  brandStatementTemplates,
  brandStatements,
  brands,
  organizationMembers,
  parties,
  users,
} = schema;

export type StatementRow = typeof brandStatements.$inferSelect;
export type LineRow = typeof brandStatementLines.$inferSelect;
export type MatchRow = typeof brandStatementMatches.$inferSelect;

/** What a statement is matched with: its template's tolerances and GRN basis. */
export interface StatementContext {
  readonly statement: StatementRow;
  readonly tolerance: StatementTolerance;
  readonly grnAmountBasis: StatementGrnBasis;
}

export async function statementContext(
  tx: Transaction,
  statementId: string,
  lock = false,
): Promise<StatementContext | null> {
  const query = tx
    .select({
      statement: brandStatements,
      dateWindowDays: brandStatementTemplates.dateWindowDays,
      amountTolerancePaise: brandStatementTemplates.amountTolerancePaise,
      grnAmountBasis: brandStatementTemplates.grnAmountBasis,
    })
    .from(brandStatements)
    .innerJoin(brandStatementTemplates, eq(brandStatementTemplates.id, brandStatements.templateId))
    .where(eq(brandStatements.id, statementId));
  const [row] = lock ? await query.for('update', { of: brandStatements }) : await query;
  if (!row) return null;
  return {
    statement: row.statement,
    tolerance: {
      dateWindowDays: row.dateWindowDays,
      amountTolerancePaise: row.amountTolerancePaise,
    },
    grnAmountBasis: row.grnAmountBasis,
  };
}

export const grnKey = (id: string) => `grn:${id}`;
export const receiptKey = (id: string) => `benefit_receipt:${id}`;
export const recordKeyOf = (match: Pick<MatchRow, 'goodsReceiptId' | 'benefitReceiptId'>) =>
  match.goodsReceiptId !== null
    ? grnKey(match.goodsReceiptId)
    : match.benefitReceiptId !== null
      ? receiptKey(match.benefitReceiptId)
      : null;

/** A record key's kind and id (keys are checked by the request schema or made here). */
export function parseRecordKey(key: string): { kind: 'grn' | 'benefit_receipt'; id: string } {
  const [kind, id] = key.split(':') as ['grn' | 'benefit_receipt', string];
  return { kind, id };
}

/**
 * Our records around the statement: the supplier's GRNs (dated by the supplier's invoice,
 * else the day received) and the brand's scheme money, from the window before the period
 * to the window after it, and any the statement's lines already settle. A GRN counts at
 * its taxable value (paid units × cost) plus GST at its products' rates on that day, or
 * before GST, as the template says; scheme money counts negative, as a credit.
 */
export async function ourRecords(
  tx: Transaction,
  context: StatementContext,
  settledKeys: readonly string[],
): Promise<Omit<OurRecordView, 'lineId' | 'elsewhere'>[]> {
  const { statement, tolerance } = context;
  const from = sql`(${statement.periodFrom}::date - ${tolerance.dateWindowDays}::int)`;
  const to = sql`(${statement.periodTo}::date + ${tolerance.dateWindowDays}::int)`;
  const settled = settledKeys.map(parseRecordKey);
  const settledGrns = settled.filter((key) => key.kind === 'grn').map((key) => key.id);
  const settledReceipts = settled.filter((key) => key.kind !== 'grn').map((key) => key.id);
  const ids = (list: string[]) =>
    list.length === 0
      ? sql`array[]::uuid[]`
      : sql`array[${sql.join(
          list.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`;

  const grns = await tx.execute<{
    id: string;
    number: string;
    reference: string | null;
    day: string;
    taxable: string;
    gst: string;
  }>(sql`
    with receipts as (
      select g.id, g.number, g.supplier_invoice_number as reference,
        coalesce(g.supplier_invoice_date, (g.received_at at time zone 'Asia/Kolkata')::date) as day
      from goods_receipts g
      where g.organization_id = ${statement.organizationId}
        and g.supplier_party_id = ${statement.supplierPartyId}
    )
    select r.id, r.number, r.reference, r.day::text as day,
      coalesce(sum(round(l.quantity * l.unit_cost_paise)), 0)::text as taxable,
      coalesce(sum(round(round(l.quantity * l.unit_cost_paise)
        * coalesce(t.rate_bps, p.gst_rate_bps) / 10000.0)), 0)::text as gst
    from receipts r
    left join goods_receipt_lines l on l.goods_receipt_id = r.id
    left join product_variants v on v.id = l.variant_id
    left join products p on p.id = v.product_id
    left join tax_rates t on t.tax_category_id = p.tax_category_id
      and r.day between t.effective_from and coalesce(t.effective_to, r.day)
    where r.day between ${from} and ${to} or r.id = any(${ids(settledGrns)})
    group by r.id, r.number, r.reference, r.day
    order by r.day, r.number`);

  const receipts =
    statement.brandId === null
      ? []
      : await tx
          .select({
            id: brandBenefitReceipts.id,
            schemeId: brandSchemes.id,
            schemeName: brandSchemes.name,
            reference: brandBenefitReceipts.reference,
            day: brandBenefitReceipts.receivedOn,
            amountPaise: brandBenefitReceipts.amountPaise,
          })
          .from(brandBenefitReceipts)
          .innerJoin(brandSchemes, eq(brandSchemes.id, brandBenefitReceipts.schemeId))
          .where(
            and(
              eq(brandSchemes.brandId, statement.brandId),
              eq(brandBenefitReceipts.kind, 'money'),
              sql`(${brandBenefitReceipts.receivedOn} between ${from} and ${to}
                or ${brandBenefitReceipts.id} = any(${ids(settledReceipts)}))`,
            ),
          )
          .orderBy(asc(brandBenefitReceipts.receivedOn), asc(brandBenefitReceipts.id));

  const inPeriod = (day: string) => day >= statement.periodFrom && day <= statement.periodTo;
  return [
    ...grns.rows.map((row) => ({
      key: grnKey(row.id),
      kind: 'grn' as const,
      id: row.id,
      number: row.number,
      reference: row.reference,
      date: row.day,
      amountPaise:
        Number(row.taxable) + (context.grnAmountBasis === 'with_gst' ? Number(row.gst) : 0),
      inPeriod: inPeriod(row.day),
      schemeId: null,
    })),
    ...receipts.map((row) => ({
      key: receiptKey(row.id),
      kind: 'benefit_receipt' as const,
      id: row.id,
      number: row.schemeName,
      reference: row.reference,
      date: row.day,
      amountPaise: -Number(row.amountPaise),
      inPeriod: inPeriod(row.day),
      schemeId: row.schemeId,
    })),
  ];
}

/** The statement's lines in file order. */
export function statementLines(tx: Transaction, statementId: string): Promise<LineRow[]> {
  return tx
    .select()
    .from(brandStatementLines)
    .where(eq(brandStatementLines.statementId, statementId))
    .orderBy(asc(brandStatementLines.rowNumber));
}

/** How the statement's lines were settled, with who did it. */
export function statementMatches(
  tx: Transaction,
  statementId: string,
): Promise<(MatchRow & { by: string | null })[]> {
  return tx
    .select({
      id: brandStatementMatches.id,
      organizationId: brandStatementMatches.organizationId,
      statementId: brandStatementMatches.statementId,
      lineId: brandStatementMatches.lineId,
      source: brandStatementMatches.source,
      goodsReceiptId: brandStatementMatches.goodsReceiptId,
      benefitReceiptId: brandStatementMatches.benefitReceiptId,
      differencePaise: brandStatementMatches.differencePaise,
      note: brandStatementMatches.note,
      memberId: brandStatementMatches.memberId,
      createdAt: brandStatementMatches.createdAt,
      by: users.fullName,
    })
    .from(brandStatementMatches)
    .leftJoin(organizationMembers, eq(organizationMembers.id, brandStatementMatches.memberId))
    .leftJoin(users, eq(users.id, organizationMembers.userId))
    .where(eq(brandStatementMatches.statementId, statementId))
    .orderBy(asc(brandStatementMatches.createdAt), asc(brandStatementMatches.id));
}

/** Keys of records settling a line of another statement. */
async function settledElsewhere(
  tx: Transaction,
  statementId: string,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const parsed = keys.map(parseRecordKey);
  const grnIds = parsed.filter((key) => key.kind === 'grn').map((key) => key.id);
  const receiptIds = parsed.filter((key) => key.kind !== 'grn').map((key) => key.id);
  const rows = await tx
    .select({
      goodsReceiptId: brandStatementMatches.goodsReceiptId,
      benefitReceiptId: brandStatementMatches.benefitReceiptId,
    })
    .from(brandStatementMatches)
    .where(
      and(
        ne(brandStatementMatches.statementId, statementId),
        ne(brandStatementMatches.source, 'rejected'),
        sql`(${grnIds.length > 0 ? inArray(brandStatementMatches.goodsReceiptId, grnIds) : sql`false`}
          or ${receiptIds.length > 0 ? inArray(brandStatementMatches.benefitReceiptId, receiptIds) : sql`false`})`,
      ),
    );
  return new Set(rows.map((row) => String(recordKeyOf(row))));
}

/** Everything the screen and the matching run need. */
export async function loadStatement(tx: Transaction, context: StatementContext) {
  const statementId = context.statement.id;
  const lines = await statementLines(tx, statementId);
  const matches = await statementMatches(tx, statementId);
  const settling = matches.filter((match) => match.source !== 'rejected');
  const records = await ourRecords(
    tx,
    context,
    settling.flatMap((match) => {
      const key = recordKeyOf(match);
      return key === null ? [] : [key];
    }),
  );
  const elsewhere = await settledElsewhere(
    tx,
    statementId,
    records.map((record) => record.key),
  );
  return { lines, matches, settling, records, elsewhere };
}

/** The automatic pairs the statement should have now. */
export function autoPairs(
  context: StatementContext,
  loaded: Awaited<ReturnType<typeof loadStatement>>,
): AutoMatch[] {
  return matchStatement({
    lines: loaded.lines,
    records: loaded.records.map((record) => ({
      key: record.key,
      date: record.date,
      references: [record.reference],
      amountPaise: record.amountPaise,
    })),
    fixed: loaded.settling
      .filter((match) => match.source !== 'auto')
      .map((match) => ({ lineId: match.lineId, recordKey: recordKeyOf(match) })),
    rejected: loaded.matches
      .filter((match) => match.source === 'rejected')
      .map((match) => ({ lineId: match.lineId, recordKey: String(recordKeyOf(match)) })),
    elsewhere: loaded.elsewhere,
    tolerance: context.tolerance,
  });
}

/**
 * Brings the automatic pairs up to date (idempotent: a run with nothing new writes
 * nothing). Members' matches, explanations and rejections are never touched. One run
 * per supplier at a time, so two statements never take the same GRN.
 */
export async function runMatching(
  tx: Transaction,
  context: StatementContext,
): Promise<{ added: number; removed: number }> {
  const { statement } = context;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`brand-statement-match:${statement.organizationId}:${statement.supplierPartyId}`}, 0))`,
  );
  const loaded = await loadStatement(tx, context);
  const wanted = autoPairs(context, loaded);
  const signature = (lineId: string, key: string | null, difference: number | null) =>
    `${lineId}|${String(key)}|${String(difference)}`;
  const wantedSignatures = new Set(
    wanted.map((pair) => signature(pair.lineId, pair.recordKey, pair.differencePaise)),
  );
  const current = loaded.matches.filter((match) => match.source === 'auto');
  const currentSignatures = new Set(
    current.map((match) => signature(match.lineId, recordKeyOf(match), match.differencePaise)),
  );
  const stale = current.filter(
    (match) =>
      !wantedSignatures.has(signature(match.lineId, recordKeyOf(match), match.differencePaise)),
  );
  const fresh = wanted.filter(
    (pair) => !currentSignatures.has(signature(pair.lineId, pair.recordKey, pair.differencePaise)),
  );
  if (stale.length > 0) {
    await tx.delete(brandStatementMatches).where(
      inArray(
        brandStatementMatches.id,
        stale.map((match) => match.id),
      ),
    );
  }
  if (fresh.length > 0) {
    await tx.insert(brandStatementMatches).values(
      fresh.map((pair) => {
        const { kind, id } = parseRecordKey(pair.recordKey);
        return {
          organizationId: statement.organizationId,
          statementId: statement.id,
          lineId: pair.lineId,
          source: 'auto' as const,
          goodsReceiptId: kind === 'grn' ? id : null,
          benefitReceiptId: kind === 'grn' ? null : id,
          differencePaise: pair.differencePaise,
        };
      }),
    );
  }
  await tx
    .update(brandStatements)
    .set({ matchedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(brandStatements.id, statement.id));
  return { added: fresh.length, removed: stale.length };
}

/** The statement as lists show it. */
export async function statementSummaries(
  tx: Transaction,
  where: ReturnType<typeof and>,
): Promise<BrandStatementSummaryView[]> {
  const rows = await tx
    .select({
      statement: brandStatements,
      templateName: brandStatementTemplates.name,
      tolerance: brandStatementTemplates.amountTolerancePaise,
      supplierName: parties.displayName,
      brandName: brands.name,
      uploadedBy: users.fullName,
      // Matched in the transaction that imports it.
      matchedAt:
        sql<string>`coalesce(${brandStatements.matchedAt}, ${brandStatements.createdAt})`.mapWith(
          (value: string | Date) => new Date(value).toISOString(),
        ),
      lines: sql<number>`(select count(*)::int from ${brandStatementLines} l
        where l.statement_id = ${brandStatements.id} and l.kind <> 'opening')`,
      mismatches: sql<number>`(select count(*)::int from ${brandStatementLines} l
        left join ${brandStatementMatches} m on m.line_id = l.id and m.source <> 'rejected'
        where l.statement_id = ${brandStatements.id} and l.kind not in ('opening', 'payment')
          and (m.id is null or (m.source <> 'explained'
            and abs(m.difference_paise) > ${brandStatementTemplates.amountTolerancePaise})))`,
    })
    .from(brandStatements)
    .innerJoin(brandStatementTemplates, eq(brandStatementTemplates.id, brandStatements.templateId))
    .innerJoin(parties, eq(parties.id, brandStatements.supplierPartyId))
    .leftJoin(brands, eq(brands.id, brandStatements.brandId))
    .innerJoin(organizationMembers, eq(organizationMembers.id, brandStatements.uploadedByMemberId))
    .innerJoin(users, eq(users.id, organizationMembers.userId))
    .where(where)
    .orderBy(sql`${brandStatements.periodFrom} desc`, sql`${brandStatements.number} desc`);
  return rows.map((row) => ({
    id: row.statement.id,
    number: row.statement.number,
    template: { id: row.statement.templateId, name: row.templateName },
    supplier: { id: row.statement.supplierPartyId, name: row.supplierName },
    brand:
      row.statement.brandId === null
        ? null
        : { id: row.statement.brandId, name: String(row.brandName) },
    periodFrom: row.statement.periodFrom,
    periodTo: row.statement.periodTo,
    status: row.statement.status,
    fileName: row.statement.fileName,
    fileKept: row.statement.storageKey !== null,
    lines: row.lines,
    mismatches: row.mismatches,
    uploadedBy: row.uploadedBy,
    createdAt: row.statement.createdAt.toISOString(),
    // Matched in the transaction that imports it.
    matchedAt: row.matchedAt,
  }));
}

/** The reconciliation screen: both sides, how each line stands, and the period's figures. */
export async function statementDetail(
  tx: Transaction,
  context: StatementContext,
): Promise<BrandStatementDetail> {
  const { statement, tolerance } = context;
  const [summaryView] = (await statementSummaries(
    tx,
    and(eq(brandStatements.id, statement.id)),
  )) as [BrandStatementSummaryView];
  const loaded = await loadStatement(tx, context);
  const settlementOf = new Map(loaded.settling.map((match) => [match.lineId, match]));
  const lineOfRecord = new Map(
    loaded.settling.flatMap((match) => {
      const key = recordKeyOf(match);
      return key === null ? [] : [[key, match.lineId] as const];
    }),
  );
  const lines: StatementLineView[] = loaded.lines.map((line) => {
    const match = settlementOf.get(line.id);
    const status = lineStatus(
      line,
      match
        ? { explained: match.source === 'explained', differencePaise: match.differencePaise }
        : null,
      tolerance,
    );
    return {
      id: line.id,
      rowNumber: line.rowNumber,
      lineDate: line.lineDate,
      kind: line.kind,
      documentNumber: line.documentNumber,
      typeText: line.typeText,
      reference: line.reference,
      description: line.description,
      amountPaise: line.amountPaise,
      status,
      match: match
        ? {
            source: match.source as 'auto' | 'manual' | 'explained',
            recordKey: recordKeyOf(match),
            differencePaise: match.differencePaise,
            note: match.note,
            by: match.by,
          }
        : null,
      rejected: loaded.matches
        .filter((rejected) => rejected.source === 'rejected' && rejected.lineId === line.id)
        .map((rejected) => String(recordKeyOf(rejected))),
    };
  });
  const ours: OurRecordView[] = loaded.records.map((record) => ({
    ...record,
    lineId: lineOfRecord.get(record.key) ?? null,
    elsewhere: loaded.elsewhere.has(record.key),
  }));
  const summary = statementSummary(
    lines.map((line) => ({
      kind: line.kind,
      amountPaise: line.amountPaise,
      status: line.status,
      differencePaise:
        line.match?.source === 'explained' ? null : (line.match?.differencePaise ?? null),
    })),
    ours.map((record) => ({
      amountPaise: record.amountPaise,
      inPeriod: record.inPeriod,
      matched: record.lineId !== null,
      elsewhere: record.elsewhere,
    })),
    {
      openingBalancePaise: statement.openingBalancePaise,
      printedClosingPaise: statement.closingBalancePaise,
    },
  );
  return { statement: summaryView, tolerance, summary, lines, ours };
}
