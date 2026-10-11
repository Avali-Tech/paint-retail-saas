import 'reflect-metadata';
import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { schema, withTenant, type DatabaseConnection, type Transaction } from '@paint/db';
import {
  ACCOUNTING_EXPORT_KINDS,
  DEFAULT_TALLY_VOUCHER_TYPES,
  accountingExportFile,
  buildTallyExport,
  checkTallyExport,
  type AccountingExportFile,
  type AccountingExportKind,
  type AccountingExportPage,
  type AccountingExportPreview,
  type AccountingExportView,
  type TallyExportOptions,
  type TallyPeriod,
} from '@paint/shared';
import { and, asc, between, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../auth/auth-context.js';
import { DATABASE } from '../database/database.module.js';
import { DOCUMENT_SERVICES, type DocumentServices } from '../documents/safe-upload.js';
import type {
  CreateExportInput,
  ExportPreviewQuery,
  ListExportsQuery,
} from './accounting.schemas.js';
import { mappingViews } from './ledger-mappings.service.js';
import {
  EXPORT_KIND_OF,
  bouncesOf,
  ledgerRuleOf,
  receiptsOf,
  refundsOf,
  salesDocumentsOf,
  type AllocationRow,
  type BounceRow,
  type DocumentRow,
  type ReceiptRow,
  type RefundRow,
} from './tally-period.js';

const {
  accountingExports,
  allocations,
  documents,
  organizationMembers,
  organizations,
  parties,
  partyLedger,
  paymentModes,
  payments,
  salesSettings,
  stores,
  taxCategories,
  taxDocumentLines,
  taxDocumentLinks,
  taxDocuments,
  users,
} = schema;

const original = alias(taxDocuments, 'original');
const target = alias(taxDocuments, 'target');
const reversal = alias(allocations, 'reversal');
const source = alias(payments, 'source');

const DOCUMENT_KINDS: Readonly<Record<AccountingExportKind, readonly DocumentRow['kind'][]>> = {
  sales: ['invoice', 'bill_of_supply'],
  credit_note: ['credit_note'],
  debit_note: ['debit_note'],
  receipt: [],
};

interface Gathered {
  readonly period: TallyPeriod;
  readonly counts: AccountingExportPreview['counts'];
  readonly options: TallyExportOptions;
  readonly withReceipts: AccountingExportPreview['withReceipts'];
}

const unprocessable = (message: string, issues: { path: string; message: string }[]) =>
  new UnprocessableEntityException({ statusCode: 422, message, issues });

/**
 * The accounting export (spec §6.1, P2-M07): a period's invoices, notes and
 * receipts as Tally import XML or an .xlsx, through round 2c's mapper. Each
 * export is recorded in `accounting_exports` and its file filed as a document
 * when file storage is set up.
 */
@Injectable()
export class AccountingExportsService {
  private readonly logger = new Logger('AccountingExports');

  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(DOCUMENT_SERVICES) private readonly services: DocumentServices | null,
  ) {}

  /** Past exports, newest first. */
  list(auth: AuthContext, query: ListExportsQuery): Promise<AccountingExportPage> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const rows = await tx
        .select({ row: accountingExports, createdBy: users.fullName })
        .from(accountingExports)
        .innerJoin(
          organizationMembers,
          eq(organizationMembers.id, accountingExports.createdByMemberId),
        )
        .innerJoin(users, eq(users.id, organizationMembers.userId))
        .orderBy(desc(accountingExports.createdAt), desc(accountingExports.id))
        .limit(query.limit)
        .offset(query.offset);
      const [total] = await tx.select({ value: count() }).from(accountingExports);
      return {
        items: rows.map(({ row, createdBy }) => this.toView(row, createdBy)),
        total: Number(total?.value),
      };
    });
  }

  /** What an export would hold, and every problem that would stop it. */
  preview(auth: AuthContext, query: ExportPreviewQuery): Promise<AccountingExportPreview> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { period, options, withReceipts, counts } = await this.gather(tx, auth, query);
      return {
        from: query.from,
        to: query.to,
        companyName: period.companyName,
        counts,
        problems: checkTallyExport(period, options),
        withReceipts,
      };
    });
  }

  /** Builds the file, records the export and files a copy; refuses with every problem at once. */
  create(
    auth: AuthContext,
    input: CreateExportInput,
  ): Promise<{ view: AccountingExportView; file: AccountingExportFile }> {
    return withTenant(this.connection.db, auth.organization.id, async (tx) => {
      const { period, options } = await this.gather(tx, auth, input, input.companyName);
      const problems = checkTallyExport(period, options);
      if (problems.length > 0) {
        throw unprocessable(
          'Cannot export to Tally',
          problems.map((problem) => ({ path: problem.code, message: problem.message })),
        );
      }
      const { documents: docs, receipts, refunds, bounces } = period;
      if (docs.length + receipts.length + refunds.length + bounces.length === 0) {
        throw unprocessable('Nothing to export', [
          { path: 'from', message: 'There are no documents or payments in this period' },
        ]);
      }
      const data = buildTallyExport(period, options);
      const file = accountingExportFile(data, input.format);
      const [row] = (await tx
        .insert(accountingExports)
        .values({
          organizationId: auth.organization.id,
          periodFrom: input.from,
          periodTo: input.to,
          kinds: [...input.kinds],
          format: input.format,
          voucherCount: data.vouchers.length,
          createdByMemberId: auth.memberId,
        })
        .returning()) as [typeof accountingExports.$inferSelect];
      const documentId = await this.file(tx, auth, row.id, file);
      return { view: this.toView({ ...row, documentId }, auth.user.fullName), file };
    });
  }

  // Helpers -----------------------------------------------------------------

  /**
   * Keeps a copy of the file as a document on the export (the file is ours,
   * so it is not virus-scanned). Without working storage the export still
   * downloads; it is just not kept, and the log says so.
   */
  private async file(
    tx: Transaction,
    auth: AuthContext,
    exportId: string,
    file: AccountingExportFile,
  ): Promise<string | null> {
    if (!this.services) return null;
    const id = crypto.randomUUID();
    const storageKey = `${auth.organization.id}/documents/${id}`;
    const data = Buffer.from(file.bytes);
    try {
      await this.services.storage.put(storageKey, data, file.contentType);
    } catch (error) {
      this.logger.warn(
        `Accounting export ${exportId} was not filed: storage failed (${(error as Error).message})`,
      );
      return null;
    }
    await tx.insert(documents).values({
      id,
      organizationId: auth.organization.id,
      recordType: 'accounting_export',
      recordId: exportId,
      category: 'accounting_export',
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      storageKey,
      uploadedByMemberId: auth.memberId,
    });
    await tx
      .update(accountingExports)
      .set({ documentId: id })
      .where(eq(accountingExports.id, exportId));
    return id;
  }

  private toView(
    row: typeof accountingExports.$inferSelect,
    createdBy: string,
  ): AccountingExportView {
    return {
      id: row.id,
      periodFrom: row.periodFrom,
      periodTo: row.periodTo,
      // The database allows only these (accounting_exports_kinds).
      kinds: row.kinds as AccountingExportKind[],
      format: row.format,
      documentId: row.documentId,
      voucherCount: row.voucherCount,
      createdBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** The period's documents and money (receipts, refunds, bounces) and the mapping rules. */
  private async gather(
    tx: Transaction,
    auth: AuthContext,
    query: {
      readonly from: string;
      readonly to: string;
      readonly kinds: readonly AccountingExportKind[];
    },
    companyName?: string,
  ): Promise<Gathered> {
    const storeFilter = (column: typeof taxDocuments.storeId | typeof payments.storeId) =>
      auth.allStores ? undefined : inArray(column, [...auth.storeIds]);
    const [business] = (await tx
      .select({
        companyName: sql<string>`coalesce(${organizations.legalName}, ${organizations.name})`,
        walkInPartyId: salesSettings.walkInPartyId,
      })
      .from(organizations)
      .leftJoin(salesSettings, eq(salesSettings.organizationId, organizations.id))
      .where(eq(organizations.id, auth.organization.id))) as [
      { companyName: string; walkInPartyId: string | null },
    ];

    const kinds = query.kinds.flatMap((kind) => DOCUMENT_KINDS[kind]);
    const documentRows: DocumentRow[] =
      kinds.length === 0
        ? []
        : await tx
            .select({
              id: taxDocuments.id,
              kind: sql<DocumentRow['kind']>`${taxDocuments.kind}`,
              status: sql<DocumentRow['status']>`${taxDocuments.status}`,
              number: sql<string>`${taxDocuments.number}`,
              issuedOn: sql<string>`${taxDocuments.issuedOn}::text`,
              storeCode: stores.code,
              supplierGstin: sql<string>`coalesce(${taxDocuments.supplierGstin}, '')`,
              supplierStateCode: sql<string>`coalesce(${taxDocuments.supplierStateCode}, '')`,
              partyId: taxDocuments.partyId,
              buyerName: taxDocuments.buyerName,
              buyerGstin: taxDocuments.buyerGstin,
              buyerStateCode: taxDocuments.buyerStateCode,
              placeOfSupplyCode: sql<string>`coalesce(${taxDocuments.placeOfSupplyCode}, '')`,
              supplyType: sql<DocumentRow['supplyType']>`${taxDocuments.supplyType}`,
              roundOffPaise: taxDocuments.roundOffPaise,
              totalPaise: taxDocuments.totalPaise,
              reason: taxDocuments.reason,
            })
            .from(taxDocuments)
            .innerJoin(stores, eq(stores.id, taxDocuments.storeId))
            .where(
              and(
                inArray(taxDocuments.kind, [...kinds]),
                inArray(taxDocuments.status, ['issued', 'cancelled']),
                between(taxDocuments.issuedOn, query.from, query.to),
                storeFilter(taxDocuments.storeId),
              ),
            )
            .orderBy(asc(taxDocuments.issuedOn), asc(taxDocuments.number));
    const documentIds = documentRows.map((doc) => doc.id);
    const lines =
      documentIds.length === 0
        ? []
        : await tx
            .select({
              documentId: taxDocumentLines.documentId,
              hsnCode: taxDocumentLines.hsnCode,
              rateBps: taxDocumentLines.rateBps,
              cessBps: taxDocumentLines.cessBps,
              categoryKey: taxCategories.key,
              taxablePaise: taxDocumentLines.taxablePaise,
              cgstPaise: taxDocumentLines.cgstPaise,
              sgstPaise: taxDocumentLines.sgstPaise,
              igstPaise: taxDocumentLines.igstPaise,
              cessPaise: taxDocumentLines.cessPaise,
            })
            .from(taxDocumentLines)
            .leftJoin(taxCategories, eq(taxCategories.id, taxDocumentLines.taxCategoryId))
            .where(inArray(taxDocumentLines.documentId, documentIds))
            .orderBy(asc(taxDocumentLines.documentId), asc(taxDocumentLines.lineNo));
    const originals =
      documentIds.length === 0
        ? []
        : await tx
            .select({
              noteId: taxDocumentLinks.fromDocumentId,
              number: sql<string>`${original.number}`,
              issuedOn: sql<string>`${original.issuedOn}::text`,
            })
            .from(taxDocumentLinks)
            .innerJoin(original, eq(original.id, taxDocumentLinks.toDocumentId))
            .where(
              and(
                inArray(taxDocumentLinks.fromDocumentId, documentIds),
                eq(taxDocumentLinks.kind, 'note_of'),
              ),
            )
            .orderBy(asc(original.issuedOn), asc(original.number));

    const money = query.kinds.includes('receipt');
    const moneyColumns = {
      id: payments.id,
      storeCode: stores.code,
      partyId: payments.partyId,
      partyName: parties.displayName,
      partyGstin: parties.gstin,
      partyStateCode: parties.placeOfSupply,
      modeKind: payments.modeKind,
      modeName: paymentModes.name,
      amountPaise: payments.amountPaise,
      reference: payments.reference,
    };
    const receiptRows: ReceiptRow[] = money
      ? await tx
          .select({
            ...moneyColumns,
            number: payments.number,
            voucherNumber: payments.voucherNumber,
            receivedOn: payments.receivedOn,
            note: payments.note,
          })
          .from(payments)
          .innerJoin(stores, eq(stores.id, payments.storeId))
          .innerJoin(parties, eq(parties.id, payments.partyId))
          .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
          .where(
            and(
              eq(payments.direction, 'in'),
              between(payments.receivedOn, query.from, query.to),
              // A bounced cheque is still the receipt it was; its bounce reverses it.
              storeFilter(payments.storeId),
            ),
          )
          .orderBy(asc(payments.receivedOn), asc(payments.number))
      : [];
    const refundRows: RefundRow[] = money
      ? await tx
          .select({
            ...moneyColumns,
            number: payments.number,
            voucherNumber: payments.voucherNumber,
            paidOn: payments.receivedOn,
            note: payments.note,
            receiptNumber: source.number,
            receiptVoucherNumber: source.voucherNumber,
            receivedOn: source.receivedOn,
          })
          .from(payments)
          .innerJoin(stores, eq(stores.id, payments.storeId))
          .innerJoin(parties, eq(parties.id, payments.partyId))
          .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
          .innerJoin(allocations, eq(allocations.refundPaymentId, payments.id))
          .innerJoin(source, eq(source.id, allocations.paymentId))
          .where(
            and(
              eq(payments.direction, 'out'),
              between(payments.receivedOn, query.from, query.to),
              storeFilter(payments.storeId),
            ),
          )
          .orderBy(asc(payments.receivedOn), asc(payments.number))
      : [];
    const bounceRows: BounceRow[] = money
      ? await tx
          .select({
            ...moneyColumns,
            bouncedOn: sql<string>`${payments.chequeBouncedOn}::text`,
            reason: sql<string>`coalesce(${payments.bounceReason}, '')`,
            // The bounce's charge is the one adjustment it posts against the payment.
            chargePaise: sql<number>`coalesce((select sum(pl.amount_paise) from ${partyLedger} pl
              where pl.entry_type = 'adjustment' and pl.reference_type = 'payment'
              and pl.reference_id = ${payments.id}), 0)`.mapWith(Number),
            receiptNumber: payments.number,
            receiptVoucherNumber: payments.voucherNumber,
            receivedOn: payments.receivedOn,
          })
          .from(payments)
          .innerJoin(stores, eq(stores.id, payments.storeId))
          .innerJoin(parties, eq(parties.id, payments.partyId))
          .innerJoin(paymentModes, eq(paymentModes.id, payments.modeId))
          .where(
            and(
              eq(payments.chequeStatus, 'bounced'),
              between(payments.chequeBouncedOn, query.from, query.to),
              storeFilter(payments.storeId),
            ),
          )
          .orderBy(asc(payments.chequeBouncedOn), asc(payments.number))
      : [];
    const sourceIds = [...documentIds, ...receiptRows.map((receipt) => receipt.id)];
    const allocationRows: AllocationRow[] =
      sourceIds.length === 0
        ? []
        : await tx
            .select({
              sourceId: sql<string>`coalesce(${allocations.paymentId}, ${allocations.creditNoteId})`,
              documentNumber: sql<string>`${target.number}`,
              amountPaise: allocations.amountPaise,
            })
            .from(allocations)
            .innerJoin(target, eq(target.id, allocations.documentId))
            .leftJoin(reversal, eq(reversal.reversesAllocationId, allocations.id))
            .where(
              and(
                or(
                  inArray(allocations.paymentId, sourceIds),
                  inArray(allocations.creditNoteId, sourceIds),
                ),
                gt(allocations.amountPaise, 0),
                // Live, or undone only by a bounce: the receipt as it was taken.
                or(isNull(reversal.id), eq(reversal.reversalReason, 'cheque_bounce')),
              ),
            )
            .orderBy(asc(allocations.createdAt), asc(allocations.id));
    const bounceIds = bounceRows.map((row) => row.id);
    const reopenedRows: AllocationRow[] =
      bounceIds.length === 0
        ? []
        : await tx
            .select({
              sourceId: sql<string>`${allocations.paymentId}`,
              documentNumber: sql<string>`${target.number}`,
              amountPaise: sql<number>`-${allocations.amountPaise}`.mapWith(Number),
            })
            .from(allocations)
            .innerJoin(target, eq(target.id, allocations.documentId))
            .where(
              and(
                inArray(allocations.paymentId, bounceIds),
                eq(allocations.reversalReason, 'cheque_bounce'),
              ),
            )
            .orderBy(asc(allocations.createdAt), asc(allocations.id));

    const mappings = await mappingViews(tx);
    const storeCodes = new Map(
      (await tx.select({ id: stores.id, code: stores.code }).from(stores)).map((row) => [
        row.id,
        row.code,
      ]),
    );
    const modeNames = new Map(
      (await tx.select({ id: paymentModes.id, name: paymentModes.name }).from(paymentModes)).map(
        (row) => [row.id, row.name],
      ),
    );
    return {
      period: {
        companyName: companyName ?? business.companyName,
        from: query.from,
        to: query.to,
        documents: salesDocumentsOf(
          documentRows,
          lines,
          originals,
          allocationRows,
          business.walkInPartyId,
        ),
        receipts: receiptsOf(receiptRows, allocationRows, business.walkInPartyId),
        refunds: refundsOf(refundRows, business.walkInPartyId),
        bounces: bouncesOf(bounceRows, reopenedRows, business.walkInPartyId),
      },
      options: {
        ledgerRules: mappings.map((mapping) => ledgerRuleOf(mapping, storeCodes, modeNames)),
        voucherTypes: DEFAULT_TALLY_VOUCHER_TYPES,
      },
      counts: Object.fromEntries(
        ACCOUNTING_EXPORT_KINDS.map((kind) => [
          kind,
          kind === 'receipt'
            ? receiptRows.length
            : documentRows.filter((doc) => EXPORT_KIND_OF[doc.kind] === kind).length,
        ]),
      ) as Record<AccountingExportKind, number>,
      withReceipts: { refunds: refundRows.length, bouncedCheques: bounceRows.length },
    };
  }
}
