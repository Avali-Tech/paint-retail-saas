import { describe, expect, it } from 'vitest';
import { catalogEndpoints } from './catalog.js';
import type { ApiClient, RequestOptions } from './client.js';
import { importEndpoints } from './imports.js';
import { purchasingEndpoints } from './purchasing.js';
import { stockCountEndpoints } from './stock-counts.js';
import { stockEndpoints } from './stock.js';
import { transferEndpoints } from './transfers.js';

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly query?: RequestOptions['query'];
}

/** An ApiClient that records each call instead of sending it. */
function recorder() {
  const calls: Call[] = [];
  const record =
    (method: string) =>
    (path: string, ...rest: unknown[]): Promise<never> => {
      const [first, second] = rest;
      const options = (method === 'GET' || method === 'DELETE' ? first : second) as
        RequestOptions | undefined;
      calls.push({
        method,
        path,
        ...(method === 'GET' || method === 'DELETE' ? {} : { body: first }),
        ...(options?.query === undefined ? {} : { query: options.query }),
      });
      return Promise.resolve(undefined as never);
    };
  const api: ApiClient = {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    patch: record('PATCH'),
    delete: record('DELETE'),
    download: record('DOWNLOAD'),
    upload: record('UPLOAD'),
  };
  return { api, calls };
}

const line = { variantId: 'v1', quantity: 2 };

describe('catalogue, stock and purchasing endpoints', () => {
  it('call the routes the API serves', async () => {
    const { api, calls } = recorder();
    const catalog = catalogEndpoints(api);
    const stock = stockEndpoints(api);
    const transfers = transferEndpoints(api);
    const counts = stockCountEndpoints(api);
    const purchasing = purchasingEndpoints(api);
    const imports = importEndpoints(api);

    await Promise.all([
      catalog.brands(),
      catalog.createBrand('Asian Paints'),
      catalog.updateBrand('b1', { isActive: false }),
      catalog.categories(),
      catalog.createCategory({ name: 'Emulsions' }),
      catalog.renameCategory('c1', 'Enamels'),
      catalog.products({ q: 'apex' }),
      catalog.product('p1'),
      catalog.lookup('8901234567890', true),
      catalog.createProduct({
        brandId: 'b1',
        name: 'Apex',
        type: 'exterior_paint',
        hsnCode: '3209',
        gstRatePercent: 18,
        variants: [],
      }),
      catalog.updateProduct('p1', { name: 'Apex Ultima' }),
      catalog.addVariant('p1', { sku: 'A-1', packSize: 1, unit: 'l', barcodes: [] }),
      catalog.updateVariant('v1', { mrpPaise: 100 }),

      stock.stores(),
      stock.storeDirectory(),
      stock.balances({ storeId: 's1' }),
      stock.record({ storeId: 's1', type: 'opening', lines: [line] }),
      stock.low({ storeId: 's1', limit: 100, offset: 0 }),
      stock.rules({ q: 'apex' }),
      stock.saveRules([
        { storeId: 's1', variantId: 'v1', minQuantity: 1, reorderLevel: 2, maxQuantity: 5 },
      ]),
      stock.deleteRule('s1', 'v1'),

      transfers.list({ status: 'requested' }),
      transfers.get('t1'),
      transfers.challan('t1'),
      transfers.create({ fromStoreId: 's1', toStoreId: 's2', lines: [line] }),
      transfers.approve('t1'),
      transfers.approve('t1', [line]),
      transfers.reject('t1', 'Not enough'),
      transfers.cancel('t1', 'Not needed'),
      transfers.dispatch('t1'),
      transfers.dispatch('t1', [line]),
      transfers.receive('t1', {}),

      counts.list({ storeId: 's1' }),
      counts.accuracy(),
      counts.get('c1'),
      counts.start({ storeId: 's1', scope: 'full' }),
      counts.record('c1', [{ code: 'A-1' }]),
      counts.submit('c1', true),
      counts.reopen('c1'),
      counts.approve('c1', [{ variantId: 'v1', reason: 'damage' }]),
      counts.cancel('c1', 'Wrong store'),

      purchasing.suppliers({ q: 'shah' }),
      purchasing.supplier('sp1'),
      purchasing.createSupplier({ kind: 'organization', displayName: 'Shah Distributors' }),
      purchasing.saveSupplierProfile('sp1', { paymentTermsDays: 30, leadTimeDays: null }),
      purchasing.saveSupplierProducts('sp1', [{ variantId: 'v1', supplierSku: null }]),
      purchasing.removeSupplierProduct('sp1', 'v1'),
      purchasing.orders({ status: 'open' }),
      purchasing.order('po1'),
      purchasing.createOrder({ supplierId: 'sp1', storeId: 's1', lines: [line] }),
      purchasing.orderFromLowStock({ supplierId: 'sp1', storeId: 's1' }),
      purchasing.cancelOrder('po1', 'Wrong supplier'),
      purchasing.closeOrder('po1', 'Rest not coming'),
      purchasing.receipts({ purchaseOrderId: 'po1' }),
      purchasing.receipt('g1'),
      purchasing.receive({
        purchaseOrderId: 'po1',
        lines: [{ ...line, freeQuantity: 1 }],
      }),

      imports.kinds(),
      imports.preview('products', 'sku\n'),
      imports.commit('products', 'sku\n'),
    ]);

    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /brands',
      'POST /brands',
      'PATCH /brands/b1',
      'GET /categories',
      'POST /categories',
      'PATCH /categories/c1',
      'GET /products',
      'GET /products/p1',
      'GET /products/lookup',
      'POST /products',
      'PATCH /products/p1',
      'POST /products/p1/variants',
      'PATCH /variants/v1',
      'GET /stores',
      'GET /stores/directory',
      'GET /stock',
      'POST /stock/movements',
      'GET /stock/low',
      'GET /reorder-rules',
      'PUT /reorder-rules',
      'DELETE /reorder-rules/s1/v1',
      'GET /transfers',
      'GET /transfers/t1',
      'GET /transfers/t1/challan',
      'POST /transfers',
      'POST /transfers/t1/approve',
      'POST /transfers/t1/approve',
      'POST /transfers/t1/reject',
      'POST /transfers/t1/cancel',
      'POST /transfers/t1/dispatch',
      'POST /transfers/t1/dispatch',
      'POST /transfers/t1/receive',
      'GET /stock-counts',
      'GET /stock-counts/accuracy',
      'GET /stock-counts/c1',
      'POST /stock-counts',
      'POST /stock-counts/c1/counts',
      'POST /stock-counts/c1/submit',
      'POST /stock-counts/c1/reopen',
      'POST /stock-counts/c1/approve',
      'POST /stock-counts/c1/cancel',
      'GET /suppliers',
      'GET /suppliers/sp1',
      'POST /parties',
      'PUT /suppliers/sp1/profile',
      'PUT /suppliers/sp1/products',
      'DELETE /suppliers/sp1/products/v1',
      'GET /purchase-orders',
      'GET /purchase-orders/po1',
      'POST /purchase-orders',
      'POST /purchase-orders/from-low-stock',
      'POST /purchase-orders/po1/cancel',
      'POST /purchase-orders/po1/close',
      'GET /goods-receipts',
      'GET /goods-receipts/g1',
      'POST /goods-receipts',
      'GET /imports',
      'POST /imports/products/preview',
      'POST /imports/products',
    ]);
  });

  it('send the bodies and filters each route expects', async () => {
    const { api, calls } = recorder();
    const transfers = transferEndpoints(api);
    const purchasing = purchasingEndpoints(api);
    const stock = stockEndpoints(api);
    await transfers.approve('t1');
    await transfers.dispatch('t1', [line]);
    await purchasing.createSupplier({ kind: 'person', displayName: 'Ravi' });
    await stock.low({ limit: 100, offset: 100 });
    await stock.saveRules([]);
    expect(calls).toEqual([
      { method: 'POST', path: '/transfers/t1/approve', body: {} },
      { method: 'POST', path: '/transfers/t1/dispatch', body: { lines: [line] } },
      {
        method: 'POST',
        path: '/parties',
        body: { kind: 'person', displayName: 'Ravi', roles: ['supplier'] },
      },
      { method: 'GET', path: '/stock/low', query: { limit: 100, offset: 100 } },
      { method: 'PUT', path: '/reorder-rules', body: { rules: [] } },
    ]);
  });
});
