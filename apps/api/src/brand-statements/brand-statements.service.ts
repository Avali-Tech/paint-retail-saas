import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  HttpStatus,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  isUniqueViolation,
  nextDocumentNumber,
  schema,
  withTenant,
  type DatabaseConnection,
  type Transaction,
} from '@paint/db';
import {
  formatDocumentNumber,
  paiseToRupees,
  parseStatementRows,
  toCsv,
  type BrandStatementDetail,
  type BrandStatementSummaryView,
  type MatchRunResult,
  type StatementLayout,
  type StatementPreview,
  type StatementTemplateView,
} from '@paint/shared';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { AuthContext } from '../auth/auth-context.js';
import { indiaToday } from '../billing/invoice-view.js';
import { only } from '../common/only.js';
import { DATABASE } from '../database/database.module.js';
import { DOCUMENT_SERVICES, type DocumentServices } from '../documents/safe-upload.js';
import { uploadRefusal } from '../documents/upload-refusals.js';
import { requireSupplier } from '../purchasing/purchasing-lookups.js';
import type {
  ExplainBody,
  ImportFields,
  ListStatementsQuery,
  ManualMatchBody,
  SchemeReceiptBody,
  TemplateBody,
} from './brand-statements.schemas.js';
import { readStatementFile, StatementFileError, type StatementFile } from './statement-file.js';
import {
  ourRecords,
  parseRecordKey,
  runMatching,
  statementContext,
  statementDetail,
  statementMatches,
  statementSummaries,
  type StatementContext,
} from './statement-data.js';

const {
  brandBenefitReceipts,
  brandClaims,
  brandSchemes,
  brandStatementLines,
  brandStatementMatches,
  brandStatementTemplates,
  brandStatements,
  brands,
  parties,
} = schema;

export interface UploadedStatement {
  readonly fileName: string;
  readonly data: Buffer;
}

type TemplateRow = typeof brandStatementTemplates.$inferSelect;

const layoutOf = (template: TemplateRow): StatementLayout => ({
  headerRowsToSkip: template.headerRowsToSkip,
  dateColumn: template.dateColumn,
  documentColumn: template.documentColumn,
  typeColumn: template.typeColumn,
  referenceColumn: template.referenceColumn,
  descriptionColumn: template.descriptionColumn,
  amountMode: template.amountMode,
  debitColumn: template.debitColumn,
  creditColumn: template.creditColumn,
  amountColumn: template.amountColumn,
  signConvention: template.signConvention,
  dateFormat: template.dateFormat,
  typeRules: template.typeRules,
});

const SETTLED_CONSTRAINTS = [
  'brand_statement_matches_line_unique',
  'brand_statement_matches_grn_unique',
  'brand_statement_matches_receipt_unique',
];

/**
 * Brand statement reconciliation (roadmap P2-M34; spec §6.3): statement templates, the
 * import of a month's statement (CSV or Excel), matching its lines with our GRNs and the
 * scheme money we recorded, members' matches and explanations, and the mismatch list.
 * Viewing needs `purchasing:read`; everything else `schemes:manage` (controller).
 */
@Injectable()
export class BrandStatementsService {
  constructor(
    @Inject(DATABASE) private readonly connection: DatabaseConnection,
    @Inject(DOCUMENT_SERVICES) private readonly files: DocumentServices | null,
  ) {}

  private async tenant<T>(auth: AuthContext, work: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.connection.db, auth.organization.id, work);
    } catch (error) {
      if (isUniqueViolation(error, ['brand_statement_templates_name_unique'])) {
        throw new ConflictException('A template of that name already exists');
      }
      if (isUniqueViolation(error, SETTLED_CONSTRAINTS)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'already_settled',
          message: 'That line or record was settled meanwhile: reload and try again',
        });
      }
      throw error;
    }
  }

  // Templates ----------------------------------------------------------------

  listTemplates(auth: AuthContext): Promise<StatementTemplateView[]> {
    return this.tenant(auth, (tx) => this.templateViews(tx));
  }

  createTemplate(auth: AuthContext, body: TemplateBody): Promise<StatementTemplateView> {
    return this.tenant(auth, async (tx) => {
      await this.checkTemplate(tx, body);
      const [row] = (await tx
        .insert(brandStatementTemplates)
        .values({
          organizationId: auth.organization.id,
          ...body,
          createdByMemberId: auth.memberId,
        })
        .returning({ id: brandStatementTemplates.id })) as [{ id: string }];
      return this.templateView(tx, row.id);
    });
  }

  updateTemplate(
    auth: AuthContext,
    id: string,
    body: TemplateBody,
  ): Promise<StatementTemplateView> {
    return this.tenant(auth, async (tx) => {
      const current = await this.template(tx, id);
      if (current.supplierPartyId !== body.supplierPartyId) {
        throw new ConflictException(
          'A template keeps its supplier: make a new template for another supplier',
        );
      }
      await this.checkTemplate(tx, body);
      await tx
        .update(brandStatementTemplates)
        .set({ ...body, updatedAt: sql`now()` })
        .where(eq(brandStatementTemplates.id, id));
      return this.templateView(tx, id);
    });
  }

  private async checkTemplate(tx: Transaction, body: TemplateBody) {
    await requireSupplier(tx, body.supplierPartyId);
    if (body.brandId !== null) {
      only(
        await tx.select({ id: brands.id }).from(brands).where(eq(brands.id, body.brandId)),
        'Brand',
      );
    }
  }

  private async template(tx: Transaction, id: string): Promise<TemplateRow> {
    return only(
      await tx.select().from(brandStatementTemplates).where(eq(brandStatementTemplates.id, id)),
      'Template',
    );
  }

  private async templateViews(tx: Transaction, id?: string): Promise<StatementTemplateView[]> {
    const rows = await tx
      .select({
        template: brandStatementTemplates,
        supplierName: parties.displayName,
        brandName: brands.name,
        statements: sql<number>`(select count(*)::int from ${brandStatements} s
          where s.template_id = ${brandStatementTemplates.id} and s.status = 'active')`,
      })
      .from(brandStatementTemplates)
      .innerJoin(parties, eq(parties.id, brandStatementTemplates.supplierPartyId))
      .leftJoin(brands, eq(brands.id, brandStatementTemplates.brandId))
      .where(id === undefined ? undefined : eq(brandStatementTemplates.id, id))
      .orderBy(asc(brandStatementTemplates.name));
    return rows.map(({ template, supplierName, brandName, statements }) => ({
      id: template.id,
      name: template.name,
      supplierPartyId: template.supplierPartyId,
      brandId: template.brandId,
      ...layoutOf(template),
      dateWindowDays: template.dateWindowDays,
      amountTolerancePaise: template.amountTolerancePaise,
      grnAmountBasis: template.grnAmountBasis,
      isActive: template.isActive,
      supplier: { id: template.supplierPartyId, name: supplierName },
      brand: template.brandId === null ? null : { id: template.brandId, name: String(brandName) },
      statements,
      updatedAt: template.updatedAt.toISOString(),
    }));
  }

  private async templateView(tx: Transaction, id: string): Promise<StatementTemplateView> {
    return only(await this.templateViews(tx, id), 'Template');
  }

  // Import -------------------------------------------------------------------

  private readFile(file: UploadedStatement): StatementFile {
    try {
      return readStatementFile(file.fileName, file.data);
    } catch (error) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'statement_file',
        message: (error as StatementFileError).message,
      });
    }
  }

  private async previewIn(
    tx: Transaction,
    template: TemplateRow,
    file: StatementFile,
  ): Promise<StatementPreview> {
    const parsed = parseStatementRows(file.rows, layoutOf(template));
    const [duplicate] = await tx
      .select({ number: brandStatements.number })
      .from(brandStatements)
      .where(
        and(
          eq(brandStatements.supplierPartyId, template.supplierPartyId),
          eq(brandStatements.sha256, file.sha256),
          eq(brandStatements.status, 'active'),
        ),
      );
    const moves = parsed.lines.filter((line) => line.kind !== 'opening');
    return {
      fileName: file.fileName,
      valid: parsed.errors.length === 0,
      lines: parsed.lines,
      errors: parsed.errors,
      skipped: parsed.skipped,
      periodFrom: parsed.periodFrom,
      periodTo: parsed.periodTo,
      openingBalancePaise: parsed.openingBalancePaise,
      debitsPaise: moves
        .filter((l) => l.amountPaise > 0)
        .reduce((sum, l) => sum + l.amountPaise, 0),
      creditsPaise: moves
        .filter((l) => l.amountPaise < 0)
        .reduce((sum, l) => sum - l.amountPaise, 0),
      duplicateOf: duplicate?.number ?? null,
    };
  }

  /** Reads a statement with its template and shows what it would import, storing nothing. */
  preview(
    auth: AuthContext,
    templateId: string,
    upload: UploadedStatement,
  ): Promise<StatementPreview> {
    const file = this.readFile(upload);
    return this.tenant(auth, async (tx) =>
      this.previewIn(tx, await this.template(tx, templateId), file),
    );
  }

  /**
   * Imports a statement: its lines are stored and matched at once. The file is scanned
   * first and a virus refuses it; a clean file is kept in document storage. When the
   * scanner or storage is unavailable (or not set up), the lines are imported and the
   * file is not kept ([PO-93]). One statement per supplier and period, a file once.
   */
  async import(
    auth: AuthContext,
    fields: ImportFields,
    upload: UploadedStatement,
  ): Promise<BrandStatementDetail> {
    const file = this.readFile(upload);
    const scanned = await this.scan(file);
    return this.tenant(auth, async (tx) => {
      const template = await this.template(tx, fields.templateId);
      // One import per supplier at a time, so the duplicate checks below always hold.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`brand-statement-import:${auth.organization.id}:${template.supplierPartyId}`}, 0))`,
      );
      if (!template.isActive) {
        throw new ConflictException(
          'This template is switched off: switch it on or choose another',
        );
      }
      const preview = await this.previewIn(tx, template, file);
      if (!preview.valid) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'statement_rows',
          message: 'Nothing was imported: the file has rows the template cannot read',
          preview,
        });
      }
      if (preview.duplicateOf !== null) {
        throw new ConflictException({
          statusCode: 409,
          code: 'statement_duplicate',
          message: `This file is already imported as ${preview.duplicateOf}`,
        });
      }
      const periodFrom = fields.periodFrom ?? String(preview.periodFrom);
      const periodTo = fields.periodTo ?? String(preview.periodTo);
      if (periodTo < periodFrom) {
        throw new BadRequestException('The period ends before it starts');
      }
      if (Date.parse(periodTo) - Date.parse(periodFrom) >= 366 * 86_400_000) {
        throw new BadRequestException('A statement covers at most a year');
      }
      const outside = preview.lines.find(
        (line) => line.lineDate < periodFrom || line.lineDate > periodTo,
      );
      if (outside) {
        throw new BadRequestException(
          `Row ${String(outside.rowNumber)} is dated ${outside.lineDate}, outside the period`,
        );
      }
      const [samePeriod] = await tx
        .select({ number: brandStatements.number })
        .from(brandStatements)
        .where(
          and(
            eq(brandStatements.supplierPartyId, template.supplierPartyId),
            eq(brandStatements.periodFrom, periodFrom),
            eq(brandStatements.periodTo, periodTo),
            eq(brandStatements.status, 'active'),
          ),
        );
      if (samePeriod) {
        throw new ConflictException({
          statusCode: 409,
          code: 'statement_duplicate',
          message: `${samePeriod.number} is this supplier's statement for that period: discard it first`,
        });
      }
      const id = crypto.randomUUID();
      const storageKey = scanned === null ? null : await this.store(scanned, auth, id, file);
      const number = formatDocumentNumber(
        'BS',
        await nextDocumentNumber(tx, auth.organization.id, 'brand_statement'),
      );
      await tx.insert(brandStatements).values({
        id,
        organizationId: auth.organization.id,
        number,
        templateId: template.id,
        supplierPartyId: template.supplierPartyId,
        brandId: template.brandId,
        periodFrom,
        periodTo,
        openingBalancePaise: fields.openingBalancePaise ?? preview.openingBalancePaise,
        closingBalancePaise: fields.closingBalancePaise ?? null,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        storageKey,
        uploadedByMemberId: auth.memberId,
      });
      for (let start = 0; start < preview.lines.length; start += 1000) {
        await tx.insert(brandStatementLines).values(
          preview.lines.slice(start, start + 1000).map((line) => ({
            organizationId: auth.organization.id,
            statementId: id,
            ...line,
          })),
        );
      }
      const context = await this.context(tx, id, true);
      await runMatching(tx, context);
      return statementDetail(tx, context);
    });
  }

  /**
   * Scans the file before anything is read into the books: a virus refuses the import
   * (422). True when it was scanned clean; false when there is no scanner or it is down,
   * and the file will then not be kept ([PO-93]).
   */
  private async scan(file: StatementFile): Promise<DocumentServices | null> {
    const services = this.files;
    if (services === null) return null;
    let result;
    try {
      result = await services.scanner.scan(file.data);
    } catch {
      return null;
    }
    if (!result.clean) {
      throw new UnprocessableEntityException(
        uploadRefusal(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'virus_found',
          `This file contains a virus (${result.signature}) and was not imported`,
        ),
      );
    }
    return services;
  }

  /** Keeps a scanned file; null when storage is down (the lines are imported anyway). */
  private async store(
    services: DocumentServices,
    auth: AuthContext,
    id: string,
    file: StatementFile,
  ): Promise<string | null> {
    const key = `${auth.organization.id}/brand-statements/${id}`;
    try {
      await services.storage.put(key, file.data, file.contentType);
      return key;
    } catch {
      return null;
    }
  }

  // Reading ------------------------------------------------------------------

  list(auth: AuthContext, query: ListStatementsQuery): Promise<BrandStatementSummaryView[]> {
    return this.tenant(auth, (tx) =>
      statementSummaries(
        tx,
        and(
          query.supplierPartyId === undefined
            ? undefined
            : eq(brandStatements.supplierPartyId, query.supplierPartyId),
          eq(brandStatements.status, query.status ?? 'active'),
        ),
      ),
    );
  }

  detail(auth: AuthContext, id: string): Promise<BrandStatementDetail> {
    return this.tenant(auth, async (tx) => statementDetail(tx, await this.context(tx, id)));
  }

  private async context(tx: Transaction, id: string, lock = false): Promise<StatementContext> {
    const context = await statementContext(tx, id, lock);
    if (!context) throw new NotFoundException('Statement not found');
    return context;
  }

  /** The statement, locked, for a change: only an active one changes. */
  private async active(tx: Transaction, id: string): Promise<StatementContext> {
    const context = await this.context(tx, id, true);
    if (context.statement.status !== 'active') {
      throw new ConflictException('This statement is discarded');
    }
    return context;
  }

  /** The original file, when it was kept. */
  async file(
    auth: AuthContext,
    id: string,
  ): Promise<{ fileName: string; contentType: string; data: Buffer }> {
    const { statement } = await this.tenant(auth, (tx) => this.context(tx, id));
    if (statement.storageKey === null || this.files === null) {
      throw new NotFoundException('The original file of this statement was not kept');
    }
    return {
      fileName: statement.fileName,
      contentType: statement.contentType,
      data: await this.files.storage.get(statement.storageKey),
    };
  }

  /**
   * The mismatch list as CSV: the brand's lines we do not have or that differ, and our
   * records the statement does not show, with the period's figures at the end.
   */
  exportCsv(auth: AuthContext, id: string): Promise<{ fileName: string; csv: string }> {
    return this.tenant(auth, async (tx) => {
      const { statement, lines, ours, summary } = await statementDetail(
        tx,
        await this.context(tx, id),
      );
      const records = new Map(ours.map((record) => [record.key, record]));
      const money = (paise: number | null) => (paise === null ? '' : paiseToRupees(paise));
      const text = (value: string | null | undefined) => value ?? '';
      const rows: string[][] = [
        [
          'Side',
          'Status',
          'Date',
          'Document',
          'Kind',
          'Reference',
          'Description',
          'Amount',
          'Our record',
          'Our amount',
          'Difference',
          'Note',
        ],
      ];
      for (const line of lines) {
        if (line.kind === 'opening' || line.status === 'matched') continue;
        const record = line.match?.recordKey ? records.get(line.match.recordKey) : undefined;
        rows.push([
          'Brand',
          line.status,
          line.lineDate,
          text(line.documentNumber),
          line.kind,
          text(line.reference),
          text(line.description),
          money(line.amountPaise),
          text(record?.number),
          money(record?.amountPaise ?? null),
          money(line.match?.differencePaise ?? null),
          text(line.match?.note),
        ]);
      }
      for (const record of ours) {
        if (record.lineId !== null || record.elsewhere || !record.inPeriod) continue;
        rows.push([
          'Ours',
          'unmatched',
          record.date,
          record.number,
          record.kind,
          text(record.reference),
          '',
          '',
          record.number,
          money(record.amountPaise),
          '',
          '',
        ]);
      }
      rows.push([]);
      rows.push(['Brand movement', '', '', '', '', '', '', money(summary.brandMovementPaise)]);
      rows.push(['Our movement', '', '', '', '', '', '', money(summary.ourMovementPaise)]);
      rows.push(['Difference', '', '', '', '', '', '', money(summary.differencePaise)]);
      return {
        fileName: `${statement.number}-mismatches.csv`,
        csv: `\uFEFF${toCsv(rows)}`,
      };
    });
  }

  // Matching -----------------------------------------------------------------

  /** Runs the matching again: new GRNs or receipts may match lines left open. */
  rematch(auth: AuthContext, id: string): Promise<MatchRunResult> {
    return this.tenant(auth, async (tx) => {
      const context = await this.active(tx, id);
      const result = await runMatching(tx, context);
      return { ...result, detail: await statementDetail(tx, context) };
    });
  }

  private async openLine(tx: Transaction, context: StatementContext, lineId: string) {
    const line = only(
      await tx
        .select()
        .from(brandStatementLines)
        .where(
          and(
            eq(brandStatementLines.id, lineId),
            eq(brandStatementLines.statementId, context.statement.id),
          ),
        ),
      'Line',
    );
    const [settled] = await tx
      .select({ id: brandStatementMatches.id })
      .from(brandStatementMatches)
      .where(
        and(eq(brandStatementMatches.lineId, lineId), ne(brandStatementMatches.source, 'rejected')),
      );
    if (settled) {
      throw new ConflictException('This line is already matched or explained: unmatch it first');
    }
    if (line.kind === 'opening') throw new ConflictException('An opening balance is not matched');
    return line;
  }

  /** A member matches a line with one of our records, whatever the window or amount. */
  match(
    auth: AuthContext,
    id: string,
    lineId: string,
    body: ManualMatchBody,
  ): Promise<BrandStatementDetail> {
    return this.tenant(auth, async (tx) => {
      const context = await this.active(tx, id);
      const line = await this.openLine(tx, context, lineId);
      const { kind, id: recordId } = parseRecordKey(body.recordKey);
      const amount = await this.recordAmount(tx, context, body.recordKey);
      await tx
        .delete(brandStatementMatches)
        .where(
          and(
            eq(brandStatementMatches.lineId, lineId),
            eq(brandStatementMatches.source, 'rejected'),
            kind === 'grn'
              ? eq(brandStatementMatches.goodsReceiptId, recordId)
              : eq(brandStatementMatches.benefitReceiptId, recordId),
          ),
        );
      await tx.insert(brandStatementMatches).values({
        organizationId: auth.organization.id,
        statementId: id,
        lineId,
        source: 'manual',
        goodsReceiptId: kind === 'grn' ? recordId : null,
        benefitReceiptId: kind === 'grn' ? null : recordId,
        differencePaise: line.amountPaise - amount,
        note: body.note,
        memberId: auth.memberId,
      });
      return statementDetail(tx, context);
    });
  }

  /** A record's amount as the statement shows it; 400 when it is not the statement's. */
  private async recordAmount(
    tx: Transaction,
    context: StatementContext,
    key: string,
  ): Promise<number> {
    const records = await ourRecords(tx, context, [key]);
    const record = records.find((candidate) => candidate.key === key);
    if (!record) {
      throw new BadRequestException(
        "That record is not a GRN of this statement's supplier or scheme money of its brand",
      );
    }
    return record.amountPaise;
  }

  /**
   * Unmatches a line. A pair it had is remembered as rejected, so the matching run
   * never proposes it again; an explanation is simply removed.
   */
  unmatch(auth: AuthContext, id: string, lineId: string): Promise<BrandStatementDetail> {
    return this.tenant(auth, async (tx) => {
      const context = await this.active(tx, id);
      const matches = await statementMatches(tx, id);
      const settled = matches.find(
        (match) => match.lineId === lineId && match.source !== 'rejected',
      );
      if (!settled) throw new NotFoundException('This line is not matched or explained');
      await tx.delete(brandStatementMatches).where(eq(brandStatementMatches.id, settled.id));
      if (settled.source !== 'explained') {
        await tx.insert(brandStatementMatches).values({
          organizationId: auth.organization.id,
          statementId: id,
          lineId,
          source: 'rejected',
          goodsReceiptId: settled.goodsReceiptId,
          benefitReceiptId: settled.benefitReceiptId,
          memberId: auth.memberId,
        });
      }
      return statementDetail(tx, context);
    });
  }

  /** Marks a line explained with a note (freight, a rate difference, a later GRN). */
  explain(
    auth: AuthContext,
    id: string,
    lineId: string,
    body: ExplainBody,
  ): Promise<BrandStatementDetail> {
    return this.tenant(auth, async (tx) => {
      const context = await this.active(tx, id);
      await this.openLine(tx, context, lineId);
      await tx.insert(brandStatementMatches).values({
        organizationId: auth.organization.id,
        statementId: id,
        lineId,
        source: 'explained',
        note: body.note,
        memberId: auth.memberId,
      });
      return statementDetail(tx, context);
    });
  }

  /**
   * Records a credit line as scheme money the brand issued (a credit note against a
   * scheme, and its claim if named) and matches the line with it, in one step: the
   * scheme's received benefit and its claim move with it (5a).
   */
  schemeReceipt(
    auth: AuthContext,
    id: string,
    lineId: string,
    body: SchemeReceiptBody,
  ): Promise<BrandStatementDetail> {
    return this.tenant(auth, async (tx) => {
      const context = await this.active(tx, id);
      const line = await this.openLine(tx, context, lineId);
      if (line.amountPaise >= 0) {
        throw new BadRequestException(
          'Only a credit on the statement can be scheme money received',
        );
      }
      if (line.lineDate > (await indiaToday(tx))) {
        throw new BadRequestException('This line is dated in the future');
      }
      const [scheme] = await tx
        .select({ status: brandSchemes.status, brandId: brandSchemes.brandId })
        .from(brandSchemes)
        .where(eq(brandSchemes.id, body.schemeId))
        .for('update');
      const ofBrand = scheme?.brandId === context.statement.brandId;
      if (!scheme || !ofBrand) {
        throw new BadRequestException("Choose a scheme of the statement's brand");
      }
      if (scheme.status !== 'active' && scheme.status !== 'closed') {
        throw new ConflictException(
          `Benefits are recorded on an active or closed scheme; this one is ${scheme.status}`,
        );
      }
      if (body.claimId !== null) {
        only(
          await tx
            .select({ id: brandClaims.id })
            .from(brandClaims)
            .where(and(eq(brandClaims.id, body.claimId), eq(brandClaims.schemeId, body.schemeId))),
          'Claim',
        );
      }
      const [receipt] = (await tx
        .insert(brandBenefitReceipts)
        .values({
          organizationId: auth.organization.id,
          schemeId: body.schemeId,
          claimId: body.claimId,
          kind: 'money',
          moneyForm: 'credit_note',
          amountPaise: -line.amountPaise,
          receivedOn: line.lineDate,
          reference: (line.documentNumber ?? line.reference)?.slice(0, 60) ?? null,
          note:
            body.note ??
            `From brand statement ${context.statement.number}, row ${String(line.rowNumber)}`,
          recordedByMemberId: auth.memberId,
        })
        .returning({ id: brandBenefitReceipts.id })) as [{ id: string }];
      await tx.insert(brandStatementMatches).values({
        organizationId: auth.organization.id,
        statementId: id,
        lineId,
        source: 'manual',
        benefitReceiptId: receipt.id,
        differencePaise: 0,
        note: body.note,
        memberId: auth.memberId,
      });
      return statementDetail(tx, context);
    });
  }

  /** Discards a statement (a wrong file or period): its matches go, its lines stay. */
  discard(auth: AuthContext, id: string): Promise<BrandStatementSummaryView> {
    return this.tenant(auth, async (tx) => {
      await this.active(tx, id);
      await tx.delete(brandStatementMatches).where(eq(brandStatementMatches.statementId, id));
      await tx
        .update(brandStatements)
        .set({
          status: 'discarded',
          discardedAt: sql`now()`,
          discardedByMemberId: auth.memberId,
          updatedAt: sql`now()`,
        })
        .where(eq(brandStatements.id, id));
      return only(await statementSummaries(tx, eq(brandStatements.id, id)), 'Statement');
    });
  }
}
