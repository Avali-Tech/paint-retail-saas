import type { Profile } from '../../api/types.js';
import type { IssuePaymentRequest, IssuedInvoiceView, TaxDocumentView } from '@paint/shared';
import { screen } from '@testing-library/react';
import type { Product } from '../../api/catalog.js';
import { json, type FakeHandler, type FakeRequest } from '../../test-support/fake-api.js';
import { page } from '../../test-support/inventory-fixtures.js';
import { renderApp } from '../../test-support/render-app.js';
import { lineTintView } from '../../tint/test-support/tint-fixtures.js';
import type { DraftInput } from '../pos-api.js';
import {
  AMP,
  APEX,
  CASHIER_POS,
  GODOWN,
  ISSUED,
  KPH,
  MODES,
  OPTIONS,
  PUTTY,
  ROLLER,
  document,
  draftLine,
} from './pos-fixtures.js';

/** Finds products by barcode or SKU, as GET /products/lookup does. */
export function lookupIn(products: readonly Product[]): FakeHandler {
  return (request) => {
    const code = String(request.query.get('code'));
    for (const product of products) {
      const variant = product.variants.find(
        (candidate) => candidate.sku === code || candidate.barcodes.includes(code),
      );
      if (variant) return json({ product, variant });
    }
    return json({ statusCode: 404, message: 'No product with this barcode or SKU' }, 404);
  };
}

/** Name search over the products, as GET /products?q= does (name, brand, label). */
export function searchIn(products: readonly Product[]): FakeHandler {
  return (request) => {
    const q = String(request.query.get('q')).toLowerCase();
    return json(
      page(
        products.filter((product) =>
          [product.name, product.brand.name, ...product.variants.map((v) => v.label ?? '')].some(
            (text) => text.toLowerCase().includes(q),
          ),
        ),
      ),
    );
  };
}

/** A tiny invoices API: drafts kept in memory, as round 2a's would. */
export function fakeInvoices(issued: IssuedInvoiceView = ISSUED) {
  const drafts = new Map<string, TaxDocumentView>();
  let next = 0;
  const toView = (id: string, body: DraftInput): TaxDocumentView =>
    document({
      id,
      storeId: body.storeId,
      buyer: {
        partyId: body.partyId ?? null,
        name: body.buyer.name ?? null,
        gstin: body.buyer.gstin ?? null,
        address: body.buyer.address ?? null,
        stateCode: body.buyer.stateCode ?? null,
      },
      lines: body.lines.map((line, index) =>
        draftLine({
          id: `${id}-l${String(index)}`,
          lineNo: index + 1,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPricePaise: line.unitPricePaise,
          // Round 5a: the line's tint is saved with it and read back.
          ...(line.tint ? { tint: lineTintView(line.tint) } : {}),
        }),
      ),
    });
  const routes: Record<string, FakeHandler> = {
    'POST /invoices': (request: FakeRequest) => {
      next += 1;
      const id = `draft-${String(next)}`;
      drafts.set(id, toView(id, request.body as DraftInput));
      return json(drafts.get(id), 201);
    },
    'PUT /invoices/:id': (request) => {
      const id = String(request.path.split('/')[2]);
      drafts.set(id, toView(id, request.body as DraftInput));
      return json(drafts.get(id));
    },
    'DELETE /invoices/:id': (request) => {
      drafts.delete(String(request.path.split('/')[2]));
      return { status: 204 };
    },
    'GET /invoices': () =>
      json({
        items: [...drafts.values()].reverse().map((draft) => ({
          id: draft.id,
          kind: draft.kind,
          status: draft.status,
          storeId: draft.storeId,
          number: null,
          issuedOn: null,
          buyerName: draft.buyer.name,
          totalPaise: 0,
        })),
        total: drafts.size,
      }),
    'GET /invoices/:id': (request) => {
      const draft = drafts.get(String(request.path.split('/')[2]));
      return draft ? json(draft) : json({ statusCode: 404, message: 'Invoice not found' }, 404);
    },
    'POST /invoices/:id/issue': (request) => {
      drafts.delete(String(request.path.split('/')[2]));
      // Cash handed over beyond what is kept is the change, as 3a works it out.
      const { payments = [] } = request.body as { payments?: IssuePaymentRequest[] };
      const changePaise = payments.reduce(
        (sum, payment) =>
          sum + (payment.tenderedPaise ?? payment.amountPaise) - payment.amountPaise,
        0,
      );
      return json({ ...issued, changePaise });
    },
  };
  return { drafts, routes };
}

export const PRODUCTS = [APEX, PUTTY, ROLLER];

/** The counter sale screen over a fake API: a cashier at Ameerpet with cash, UPI and card. */
export function renderPos(routes: Record<string, FakeHandler> = {}, member: Profile = CASHIER_POS) {
  const invoices = fakeInvoices();
  const view = renderApp({
    path: '/pos',
    routes: {
      'GET /auth/me': () => json(member),
      'GET /stores': () => json([AMP, KPH, GODOWN]),
      'GET /tax-categories/options': () => json(OPTIONS),
      'GET /payment-modes': () => json(MODES),
      'GET /register-sessions': () =>
        json({
          items: [{ id: 'rs1', storeId: AMP.id, registerCode: 'C1', status: 'open' }],
          total: 1,
        }),
      // Plenty at the counter's store, so the "free elsewhere" hint stays away.
      'GET /stock/free-elsewhere': () =>
        json([{ store: { id: AMP.id, code: AMP.code, name: AMP.name }, available: 999 }]),
      'GET /products/lookup': lookupIn(PRODUCTS),
      'GET /products': searchIn(PRODUCTS),
      ...invoices.routes,
      ...routes,
    },
  });
  return { ...view, invoices };
}

/** The scan box, once the counter has opened. */
export const scanBox = () => screen.findByRole('combobox', { name: 'Scan or search' });

/** The bill's total as the screen shows it. */
export const total = () => screen.getByTestId('pos-total').textContent;
