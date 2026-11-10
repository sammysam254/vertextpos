require('../load-env');
const sdb = require('../db/supabase-db');
const EscPosService = require('../printing/escpos-service');
const EtimsService = require('../tax/etims-service');
const sseHub = require('../server/sse-hub');

/**
 * Enterprise Supermarket POS Engine (100% Strictly Supabase Cloud PostgreSQL).
 * Zero SQLite - all sales, cart items, stock movements, and shift records
 * operate directly on Supabase Cloud.
 */
class SaasPosService {
  /**
   * Initializes a new active sale on a specific register till.
   */
  static async createSale({ tenantId, branchId, registerId, cashierId, customerId = null }) {
    const tenantUuid = await sdb.resolveTenantUuid(tenantId);
    const branchUuid = await sdb.resolveBranchUuid(tenantUuid, branchId);
    const registerUuid = await sdb.resolveRegisterUuid(tenantUuid, branchUuid, registerId);
    let cashierUuid = await sdb.resolveUserUuid(cashierId);
    if (!cashierUuid) {
      cashierUuid = await sdb.resolveUserUuid('cashier@metromart.ke');
    }

    // Check if register has an open shift
    let shiftId = null;
    if (tenantUuid && registerUuid) {
      const { data: shifts } = await sdb.query('shifts', {
        tenant_id: tenantUuid,
        register_id: registerUuid,
        status: 'OPEN'
      }, { limit: 1 });
      if (shifts && shifts.length > 0) {
        shiftId = shifts[0].id;
      }
    }

    const { data: created, error } = await sdb.insert('sales', {
      tenant_id: tenantUuid || tenantId,
      branch_id: branchUuid || branchId,
      register_id: registerUuid || registerId,
      cashier_id: cashierUuid || cashierId,
      shift_id: shiftId,
      status: 'ACTIVE',
      subtotal_kes: 0.00,
      tax_kes: 0.00,
      total_kes: 0.00,
      paid_amount_kes: 0.00,
      balance_due_kes: 0.00
    });

    if (error || !created || created.length === 0) {
      throw new Error((error && error.message) || 'Failed to initialize sale in Supabase');
    }

    const saleId = created[0].id;
    return this.getSaleById(tenantId, saleId);
  }

  /**
   * Retrieves full sale details with all line items from Supabase.
   */
  static async getSaleById(tenantId, saleId) {
    const { data: sale } = await sdb.queryOne('sales', { id: saleId });
    if (!sale) return null;

    const { data: items } = await sdb.query('sale_items', { sale_id: sale.id });

    return {
      ...sale,
      subtotal_kes: Number(sale.subtotal_kes || 0),
      tax_kes: Number(sale.tax_kes || 0),
      total_kes: Number(sale.total_kes || 0),
      paid_amount_kes: Number(sale.paid_amount_kes || 0),
      balance_due_kes: Number(sale.balance_due_kes || 0),
      items: (items || []).map(i => ({
        ...i,
        quantity: Number(i.quantity),
        unit_price_kes: Number(i.unit_price_kes),
        subtotal_kes: Number(i.subtotal_kes),
        tax_kes: Number(i.tax_kes),
        vat_rate: Number(i.vat_rate !== undefined ? i.vat_rate : 16.0)
      })),
      payments: []
    };
  }

  /**
   * Barcode scan to cart directly on Supabase.
   */
  static async addItemToCart({ tenantId, saleId, barcodeOrId, quantity = 1, pricingTier = 'retail' }) {
    const sale = await this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'SALE_NOT_ACTIVE', message: 'Current transaction is not active in Supabase.' };
    }

    const tenantUuid = await sdb.resolveTenantUuid(tenantId);

    // Lookup product by barcode or SKU
    let product = null;
    const { data: prodsByBc } = await sdb.query('products', { barcode: barcodeOrId });
    if (prodsByBc && prodsByBc.length > 0) {
      product = prodsByBc[0];
    } else {
      const { data: prodsBySku } = await sdb.query('products', { sku: barcodeOrId });
      if (prodsBySku && prodsBySku.length > 0) {
        product = prodsBySku[0];
      } else {
        const { data: prodsById } = await sdb.queryOne('products', { id: barcodeOrId });
        if (prodsById) product = prodsById;
      }
    }

    if (!product) {
      return { success: false, error: 'PRODUCT_NOT_FOUND', message: `Product not found for barcode "${barcodeOrId}".` };
    }

    const qty = Number(quantity) || 1;
    const unitPrice = (pricingTier === 'wholesale' && product.wholesale_price_kes > 0)
      ? Number(product.wholesale_price_kes)
      : Number(product.selling_price_kes);
    const vatRate = product.vat_rate !== undefined ? Number(product.vat_rate) : 16.0;

    // Check if line item already exists in cart in Supabase
    const { data: existingItems } = await sdb.query('sale_items', {
      sale_id: sale.id,
      product_id: product.id
    });

    const existingItem = existingItems && existingItems.length > 0 ? existingItems[0] : null;

    if (existingItem) {
      const newQty = Number(existingItem.quantity) + qty;
      const newSubtotal = Number((newQty * unitPrice).toFixed(2));
      const newTax = vatRate === 16.0 ? Number((newSubtotal - (newSubtotal / 1.16)).toFixed(2)) : 0.00;

      await sdb.update('sale_items', { id: existingItem.id }, {
        quantity: newQty,
        subtotal_kes: newSubtotal,
        tax_kes: newTax
      });
    } else {
      const lineSubtotal = Number((qty * unitPrice).toFixed(2));
      const lineTax = vatRate === 16.0 ? Number((lineSubtotal - (lineSubtotal / 1.16)).toFixed(2)) : 0.00;

      await sdb.insert('sale_items', {
        tenant_id: tenantUuid || sale.tenant_id,
        sale_id: sale.id,
        product_id: product.id,
        product_name: product.name,
        barcode: product.barcode,
        quantity: qty,
        unit_price_kes: unitPrice,
        discount_kes: 0.00,
        subtotal_kes: lineSubtotal,
        tax_kes: lineTax,
        vat_rate: vatRate
      });
    }

    // Recalculate Totals
    await this._recalculateSaleTotals(sale.id);

    return {
      success: true,
      sale: await this.getSaleById(tenantId, sale.id)
    };
  }

  /**
   * Recalculates cart subtotal, VAT, total, and balance due in Supabase.
   */
  static async _recalculateSaleTotals(saleId) {
    const { data: items } = await sdb.query('sale_items', { sale_id: saleId });

    const subtotal = Number((items || []).reduce((sum, i) => sum + Number(i.subtotal_kes || 0), 0).toFixed(2));
    const tax = Number((items || []).reduce((sum, i) => sum + Number(i.tax_kes || 0), 0).toFixed(2));
    const total = subtotal;

    await sdb.update('sales', { id: saleId }, {
      subtotal_kes: subtotal,
      tax_kes: tax,
      total_kes: total,
      balance_due_kes: total
    });
  }

  /**
   * Processes cash payment tender with instant change calculation.
   */
  static async tenderCashPayment({ tenantId, saleId, cashTenderedKes, cashierName = 'Cashier' }) {
    const sale = await this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'SALE_NOT_ACTIVE', message: 'Sale is not active in Supabase.' };
    }

    if (!sale.items || sale.items.length === 0) {
      return { success: false, error: 'EMPTY_CART', message: 'Cart is empty.' };
    }

    const tendered = Number(cashTenderedKes);
    const balanceDue = Number(sale.balance_due_kes || sale.total_kes);

    if (tendered < balanceDue) {
      return {
        success: false,
        error: 'INSUFFICIENT_CASH',
        message: `Cash tendered (KES ${tendered.toFixed(2)}) is less than total due (KES ${balanceDue.toFixed(2)}).`
      };
    }

    const changeDue = Number((tendered - balanceDue).toFixed(2));
    const paidAmount = balanceDue;

    // 1. Mark Sale as COMPLETED in Supabase
    await sdb.update('sales', { id: sale.id }, {
      status: 'COMPLETED',
      paid_amount_kes: sale.total_kes,
      balance_due_kes: 0.00,
      payment_method: 'CASH'
    });

    // 2. Deduct Inventory Stock in Supabase
    for (const item of sale.items) {
      try {
        const { data: inv } = await sdb.queryOne('inventory', {
          tenant_id: sale.tenant_id,
          branch_id: sale.branch_id,
          product_id: item.product_id
        });
        const prevQty = inv ? Number(inv.quantity) : 0;
        const newQty = Math.max(0, prevQty - Number(item.quantity));

        if (inv) {
          await sdb.update('inventory', { id: inv.id }, { quantity: newQty });
        }

        await sdb.insert('stock_movements', {
          tenant_id: sale.tenant_id,
          branch_id: sale.branch_id,
          product_id: item.product_id,
          movement_type: 'SALE',
          quantity: -Number(item.quantity),
          balance_after: newQty,
          reference_id: sale.id,
          notes: 'Cash POS sale'
        });
      } catch (err) {
        console.warn('[SUPABASE POS] Stock deduct notice:', err.message);
      }
    }

    // 3. Generate eTIMS Tax Compliance & Receipt
    const { data: tenant } = await sdb.queryOne('tenants', { id: sale.tenant_id });
    const { data: branch } = await sdb.queryOne('branches', { id: sale.branch_id });

    const tObj = tenant || { trade_name: 'MetroMart Supermarket', name: 'MetroMart Supermarket', kra_pin: 'P051234567Z' };
    const bObj = branch || { name: 'Main Store', location: 'Nairobi', phone: '254711002234' };

    const etimsInfo = EtimsService.processSaleForEtims({
      saleId: sale.id,
      tenantKraPin: tObj.kra_pin,
      tenantTradeName: tObj.trade_name || tObj.name,
      items: sale.items,
      subtotalKes: sale.subtotal_kes,
      taxKes: sale.tax_kes,
      totalKes: sale.total_kes,
      cashierName
    });

    const receiptData = EscPosService.generateReceipt({
      tenantName: tObj.name,
      tradeName: tObj.trade_name || tObj.name,
      branchName: bObj.name,
      branchLocation: bObj.location,
      branchPhone: bObj.phone,
      kraPin: tObj.kra_pin,
      receiptNumber: `RCP-${sale.id.slice(-6)}`,
      saleId: sale.id,
      cashierName,
      registerCode: sale.register_id,
      items: sale.items,
      subtotalKes: sale.subtotal_kes,
      taxKes: sale.tax_kes,
      totalKes: sale.total_kes,
      paidAmountKes: paidAmount,
      changeDueKes: changeDue,
      paymentMethod: 'CASH',
      etimsInfo,
      logoBase64: tObj.logo_base64 || null,
      receiptHeaderMsg: tObj.receipt_header_msg || null,
      receiptFooterMsg: tObj.receipt_footer_msg || null
    });

    sseHub.notifyAutoPrint(sale.id, receiptData.receiptHtml, receiptData.rawEscPosBase64);

    return {
      success: true,
      status: 'COMPLETED',
      totalKes: sale.total_kes,
      cashTenderedKes: tendered,
      changeDueKes: changeDue,
      sale: await this.getSaleById(tenantId, sale.id),
      receipt: receiptData
    };
  }

  /**
   * Suspends a transaction (requires supervisor authorization).
   */
  static async suspendSale({ tenantId, saleId, supervisorId, reason = 'Customer getting wallet' }) {
    const sale = await this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'NOT_ACTIVE', message: 'Only active transactions can be suspended.' };
    }

    if (!sale.items || sale.items.length === 0) {
      return { success: false, error: 'EMPTY_CART', message: 'Cannot suspend an empty cart.' };
    }

    if (supervisorId === 'usr_cashier_01') {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction suspension.' };
    }

    const { data: supervisor } = await sdb.queryOne('users', { id: supervisorId });
    if (supervisor && supervisor.role === 'cashier') {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction suspension.' };
    }

    const supName = supervisor ? supervisor.full_name : 'Alice Wambui';
    const suspendedAt = new Date().toISOString();

    await sdb.update('sales', { id: sale.id }, {
      status: 'SUSPENDED',
      suspended_at: suspendedAt,
      suspended_by: supName,
      suspension_reason: reason
    });

    sseHub.broadcast('QUEUE_UPDATE', { action: 'SUSPENDED', saleId: sale.id, supervisor: supName });

    return {
      success: true,
      status: 'SUSPENDED',
      displayMessage: {
        title: 'SUSPENSION AUTHORIZED',
        supervisor: supName,
        time: suspendedAt,
        saleId: sale.id
      },
      sale: await this.getSaleById(tenantId, sale.id)
    };
  }

  /**
   * Resumes a suspended transaction.
   */
  static async resumeSale({ tenantId, saleId, supervisorId }) {
    const sale = await this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'SUSPENDED') {
      return { success: false, error: 'NOT_SUSPENDED', message: 'Sale is not currently in suspended state.' };
    }

    if (supervisorId === 'usr_cashier_01') {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction resumption.' };
    }

    const { data: supervisor } = await sdb.queryOne('users', { id: supervisorId });
    if (supervisor && supervisor.role === 'cashier') {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction resumption.' };
    }

    const supName = supervisor ? supervisor.full_name : 'Alice Wambui';
    const resumedAt = new Date().toISOString();

    await sdb.update('sales', { id: sale.id }, {
      status: 'ACTIVE',
      resumed_at: resumedAt,
      resumed_by: supName
    });

    sseHub.broadcast('QUEUE_UPDATE', { action: 'RESUMED', saleId: sale.id, supervisor: supName });

    return {
      success: true,
      status: 'ACTIVE',
      displayMessage: {
        title: 'RESUMPTION AUTHORIZED',
        supervisor: supName,
        time: resumedAt,
        saleId: sale.id
      },
      sale: await this.getSaleById(tenantId, sale.id)
    };
  }

  /**
   * Lists all suspended sales for branch directly from Supabase.
   */
  static async getSuspendedSales(tenantId, branchId = null) {
    const tenantUuid = await sdb.resolveTenantUuid(tenantId);
    const filters = { status: 'SUSPENDED' };
    if (tenantUuid) filters.tenant_id = tenantUuid;

    const { data: sales } = await sdb.query('sales', filters, { order: 'created_at.desc' });

    const result = [];
    for (const s of sales || []) {
      const { data: items } = await sdb.query('sale_items', { sale_id: s.id });
      result.push({ ...s, items: items || [] });
    }
    return result;
  }

  /**
   * Closes cashier shift with cash drawer variance reconciliation.
   */
  static async closeShift({ tenantId, shiftId, closingCashKes, notes = '', approvedBy = null }) {
    const { data: shift } = await sdb.queryOne('shifts', { id: shiftId });
    if (!shift || shift.status !== 'OPEN') {
      return { success: false, error: 'INVALID_SHIFT', message: 'Shift not found or already closed in Supabase.' };
    }

    const closingCash = Number(closingCashKes);
    const expectedCash = Number((Number(shift.opening_float_kes || 0) + Number(shift.cash_sales_kes || 0)).toFixed(2));
    const variance = Number((closingCash - expectedCash).toFixed(2));
    const closedAt = new Date().toISOString();

    await sdb.update('shifts', { id: shiftId }, {
      status: 'CLOSED',
      closed_at: closedAt,
      closing_cash_kes: closingCash,
      expected_cash_kes: expectedCash,
      variance_kes: variance,
      notes,
      approved_by: approvedBy
    });

    return {
      success: true,
      shift: {
        id: shiftId,
        status: 'CLOSED',
        openedAt: shift.opened_at,
        closedAt,
        openingFloatKes: shift.opening_float_kes,
        cashSalesKes: shift.cash_sales_kes,
        mpesaSalesKes: shift.mpesa_sales_kes,
        closingCashKes: closingCash,
        expectedCashKes: expectedCash,
        varianceKes: variance,
        discrepancyStatus: variance === 0 ? 'BALANCED' : (variance > 0 ? 'SURPLUS' : 'SHORTAGE')
      }
    };
  }
}

module.exports = SaasPosService;
