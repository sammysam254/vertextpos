const db = require('../db/sqlite-store');
const EscPosService = require('../printing/escpos-service');
const EtimsService = require('../tax/etims-service');
const sseHub = require('../server/sse-hub');

/**
 * Enterprise Supermarket POS Engine.
 * Built for extreme checkout speed (<100ms), KES currency, instant M-Pesa,
 * suspended sales queues, and cashier shifts.
 */
class SaasPosService {
  /**
   * Initializes a new active sale on a specific register till.
   */
  static createSale({ tenantId, branchId, registerId, cashierId, customerId = null }) {
    const saleId = `TX-${Date.now().toString().slice(-6)}-${Math.floor(Math.random() * 900 + 100)}`;
    
    // Check if cashier has active shift
    const activeShift = db.queryOne(
      'SELECT id FROM shifts WHERE tenant_id = ? AND register_id = ? AND status = \'OPEN\'',
      [tenantId, registerId]
    );

    db.run(
      `INSERT INTO sales (id, tenant_id, branch_id, register_id, cashier_id, customer_id, shift_id, status, subtotal_kes, tax_kes, total_kes, paid_amount_kes, balance_due_kes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 0.00, 0.00, 0.00, 0.00, 0.00)`,
      [saleId, tenantId, branchId, registerId, cashierId, customerId, activeShift ? activeShift.id : null]
    );

    return this.getSaleById(tenantId, saleId);
  }

  /**
   * Retrieves full sale details with all line items and payments.
   */
  static getSaleById(tenantId, saleId) {
    let sale;
    if (tenantId && tenantId !== 'GLOBAL') {
      sale = db.queryOne('SELECT * FROM sales WHERE id = ? AND tenant_id = ?', [saleId, tenantId]);
    } else {
      sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [saleId]);
    }
    if (!sale) return null;

    const items = db.queryAll('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
    const payments = db.queryAll('SELECT * FROM payments WHERE sale_id = ?', [saleId]);

    return {
      ...sale,
      items,
      payments
    };
  }

  /**
   * High-speed barcode scan to cart (< 15ms).
   */
  static addItemToCart({ tenantId, saleId, barcodeOrId, quantity = 1, pricingTier = 'retail' }) {
    const sale = db.queryOne('SELECT * FROM sales WHERE id = ? AND tenant_id = ?', [saleId, tenantId]);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'SALE_NOT_ACTIVE', message: 'Current transaction is not active.' };
    }

    // Lookup product by barcode or ID (tenant isolated with global FMCG fallback)
    let product = db.queryOne(
      'SELECT * FROM products WHERE tenant_id = ? AND (barcode = ? OR id = ? OR sku = ?)',
      [tenantId, barcodeOrId, barcodeOrId, barcodeOrId]
    );

    if (!product) {
      product = db.queryOne(
        'SELECT * FROM products WHERE barcode = ? OR id = ? OR sku = ?',
        [barcodeOrId, barcodeOrId, barcodeOrId]
      );
    }

    if (!product) {
      return { success: false, error: 'PRODUCT_NOT_FOUND', message: `Product not found for barcode "${barcodeOrId}".` };
    }

    const qty = Number(quantity) || 1;
    const unitPrice = (pricingTier === 'wholesale' && product.wholesale_price_kes > 0)
      ? product.wholesale_price_kes
      : product.selling_price_kes;
    const vatRate = product.vat_rate !== undefined ? product.vat_rate : 16.0;

    // Check if line item already exists in cart -> increment quantity
    const existingItem = db.queryOne(
      'SELECT * FROM sale_items WHERE sale_id = ? AND product_id = ?',
      [saleId, product.id]
    );

    db.transaction(() => {
      if (existingItem) {
        const newQty = existingItem.quantity + qty;
        const newSubtotal = Number((newQty * unitPrice).toFixed(2));
        const newTax = vatRate === 16.0 ? Number((newSubtotal - (newSubtotal / 1.16)).toFixed(2)) : 0.00;

        db.run(
          'UPDATE sale_items SET quantity = ?, subtotal_kes = ?, tax_kes = ? WHERE id = ?',
          [newQty, newSubtotal, newTax, existingItem.id]
        );
      } else {
        const lineSubtotal = Number((qty * unitPrice).toFixed(2));
        const lineTax = vatRate === 16.0 ? Number((lineSubtotal - (lineSubtotal / 1.16)).toFixed(2)) : 0.00;

        db.run(
          `INSERT INTO sale_items (id, tenant_id, sale_id, product_id, product_name, barcode, quantity, unit_price_kes, discount_kes, subtotal_kes, tax_kes, vat_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0.00, ?, ?, ?)`,
          [`ITM-${Date.now()}-${Math.floor(Math.random() * 1000)}`, tenantId, saleId, product.id, product.name, product.barcode, qty, unitPrice, lineSubtotal, lineTax, vatRate]
        );
      }

      // Recalculate Totals
      this._recalculateSaleTotals(saleId);
    });

    return {
      success: true,
      sale: this.getSaleById(tenantId, saleId)
    };
  }

  /**
   * Recalculates cart subtotal, VAT, total, and balance due.
   */
  static _recalculateSaleTotals(saleId) {
    const items = db.queryAll('SELECT * FROM sale_items WHERE sale_id = ?', [saleId]);
    const payments = db.queryAll('SELECT * FROM payments WHERE sale_id = ? AND status = \'SUCCEEDED\'', [saleId]);

    const subtotal = items.reduce((sum, i) => sum + i.subtotal_kes, 0);
    const tax = items.reduce((sum, i) => sum + i.tax_kes, 0);
    const total = Number(subtotal.toFixed(2));
    const paid = payments.reduce((sum, p) => sum + p.amount_kes, 0);
    const balanceDue = Number(Math.max(0, total - paid).toFixed(2));

    db.run(
      'UPDATE sales SET subtotal_kes = ?, tax_kes = ?, total_kes = ?, paid_amount_kes = ?, balance_due_kes = ? WHERE id = ?',
      [subtotal, tax, total, paid, balanceDue, saleId]
    );
  }

  /**
   * Processes cash payment tender with instant change calculation.
   */
  static tenderCashPayment({ tenantId, saleId, cashTenderedKes, cashierName = 'Cashier' }) {
    const sale = this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'SALE_NOT_ACTIVE', message: 'Sale is not active.' };
    }

    if (sale.items.length === 0) {
      return { success: false, error: 'EMPTY_CART', message: 'Cart is empty.' };
    }

    const tendered = Number(cashTenderedKes);
    const balanceDue = sale.balance_due_kes;

    if (tendered < balanceDue) {
      return { success: false, error: 'INSUFFICIENT_CASH', message: `Cash tendered (KES ${tendered.toFixed(2)}) is less than total due (KES ${balanceDue.toFixed(2)}).` };
    }

    const changeDue = Number((tendered - balanceDue).toFixed(2));
    const paidAmount = balanceDue;

    let receiptData = null;

    db.transaction(() => {
      // 1. Mark Sale as COMPLETED
      db.run(
        `UPDATE sales
         SET status = 'COMPLETED', paid_amount_kes = total_kes, balance_due_kes = 0.00, payment_method = 'CASH'
         WHERE id = ?`,
        [saleId]
      );

      // 2. Record Payment Entry
      db.run(
        `INSERT INTO payments (id, tenant_id, sale_id, method, amount_kes, status, reference)
         VALUES (?, ?, ?, 'CASH', ?, 'SUCCEEDED', ?)`,
        [`PAY-${Date.now()}`, tenantId, saleId, paidAmount, `CASH-TENDER-${tendered}`]
      );

      // 3. Deduct Inventory Stock Movements
      for (const item of sale.items) {
        const inv = db.queryOne('SELECT * FROM inventory WHERE tenant_id = ? AND branch_id = ? AND product_id = ?', [tenantId, sale.branch_id, item.product_id]);
        const prevQty = inv ? inv.quantity : 0;
        const newQty = Math.max(0, prevQty - item.quantity);

        db.run('UPDATE inventory SET quantity = ? WHERE tenant_id = ? AND branch_id = ? AND product_id = ?', [newQty, tenantId, sale.branch_id, item.product_id]);
        db.run(
          `INSERT INTO stock_movements (id, tenant_id, branch_id, product_id, movement_type, quantity, balance_after, reference_id, notes, created_by)
           VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, 'Cash POS sale', ?)`,
          [`MOV-${Date.now()}-${item.id}`, tenantId, sale.branch_id, item.product_id, -item.quantity, newQty, saleId, sale.cashier_id]
        );
      }

      // 4. Update Shift Cash Sales
      if (sale.shift_id) {
        db.run('UPDATE shifts SET cash_sales_kes = cash_sales_kes + ? WHERE id = ?', [paidAmount, sale.shift_id]);
      }
    });

    // 5. Generate eTIMS Tax Compliance & Receipt
    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]) || { trade_name: 'MetroMart Supermarket', kra_pin: 'P051234567Z' };
    const branch = db.queryOne('SELECT * FROM branches WHERE id = ?', [sale.branch_id]) || { name: 'Main Store', location: 'Nairobi', phone: '254711002234' };

    const etimsInfo = EtimsService.processSaleForEtims({
      saleId,
      tenantKraPin: tenant.kra_pin,
      tenantTradeName: tenant.trade_name,
      items: sale.items,
      subtotalKes: sale.subtotal_kes,
      taxKes: sale.tax_kes,
      totalKes: sale.total_kes,
      cashierName
    });

    receiptData = EscPosService.generateReceipt({
      tenantName: tenant.name,
      tradeName: tenant.trade_name,
      branchName: branch.name,
      branchLocation: branch.location,
      branchPhone: branch.phone,
      kraPin: tenant.kra_pin,
      receiptNumber: `RCP-${saleId.slice(-6)}`,
      saleId,
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
      logoBase64: tenant ? tenant.logo_base64 : null,
      receiptHeaderMsg: tenant ? tenant.receipt_header_msg : null,
      receiptFooterMsg: tenant ? tenant.receipt_footer_msg : null
    });

    // Auto-trigger print via SSE
    sseHub.notifyAutoPrint(saleId, receiptData.receiptHtml, receiptData.rawEscPosBase64);

    return {
      success: true,
      status: 'COMPLETED',
      totalKes: sale.total_kes,
      cashTenderedKes: tendered,
      changeDueKes: changeDue,
      sale: this.getSaleById(tenantId, saleId),
      receipt: receiptData
    };
  }

  /**
   * Suspends a transaction (requires supervisor authorization).
   * Holds cart items and any partial payments; ZERO stock deducted.
   */
  static suspendSale({ tenantId, saleId, supervisorId, reason = 'Customer getting wallet' }) {
    const sale = this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'ACTIVE') {
      return { success: false, error: 'NOT_ACTIVE', message: 'Only active transactions can be suspended.' };
    }

    if (sale.items.length === 0) {
      return { success: false, error: 'EMPTY_CART', message: 'Cannot suspend an empty cart.' };
    }

    const supervisor = db.queryOne('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [supervisorId, tenantId]);
    if (!supervisor || (supervisor.role !== 'supervisor' && supervisor.role !== 'owner' && supervisor.role !== 'admin' && supervisor.role !== 'branch_manager')) {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction suspension.' };
    }

    const suspendedAt = new Date().toISOString();

    db.run(
      `UPDATE sales
       SET status = 'SUSPENDED', suspended_at = ?, suspended_by = ?, suspension_reason = ?
       WHERE id = ?`,
      [suspendedAt, supervisor.full_name, reason, saleId]
    );

    sseHub.broadcast('QUEUE_UPDATE', { action: 'SUSPENDED', saleId, supervisor: supervisor.full_name });

    return {
      success: true,
      status: 'SUSPENDED',
      displayMessage: {
        title: 'SUSPENSION AUTHORIZED',
        supervisor: supervisor.full_name,
        time: suspendedAt,
        saleId
      },
      sale: this.getSaleById(tenantId, saleId)
    };
  }

  /**
   * Resumes a suspended transaction (requires supervisor authorization).
   * Restores all items, quantities, prices, and any previously recorded payments.
   */
  static resumeSale({ tenantId, saleId, supervisorId }) {
    const sale = this.getSaleById(tenantId, saleId);
    if (!sale || sale.status !== 'SUSPENDED') {
      return { success: false, error: 'NOT_SUSPENDED', message: 'Sale is not currently in suspended state.' };
    }

    const supervisor = db.queryOne('SELECT * FROM users WHERE id = ? AND tenant_id = ?', [supervisorId, tenantId]);
    if (!supervisor || (supervisor.role !== 'supervisor' && supervisor.role !== 'owner' && supervisor.role !== 'admin' && supervisor.role !== 'branch_manager')) {
      return { success: false, error: 'UNAUTHORIZED_SUPERVISOR', message: 'Only an authorized supervisor or manager can approve transaction resumption.' };
    }

    const resumedAt = new Date().toISOString();

    db.run(
      `UPDATE sales
       SET status = 'ACTIVE', resumed_at = ?, resumed_by = ?
       WHERE id = ?`,
      [resumedAt, supervisor.full_name, saleId]
    );

    sseHub.broadcast('QUEUE_UPDATE', { action: 'RESUMED', saleId, supervisor: supervisor.full_name });

    return {
      success: true,
      status: 'ACTIVE',
      displayMessage: {
        title: 'RESUMPTION AUTHORIZED',
        supervisor: supervisor.full_name,
        time: resumedAt,
        saleId
      },
      sale: this.getSaleById(tenantId, saleId)
    };
  }

  /**
   * Lists all suspended sales for branch.
   */
  static getSuspendedSales(tenantId, branchId = null) {
    let sql = 'SELECT * FROM sales WHERE tenant_id = ? AND status = \'SUSPENDED\'';
    const params = [tenantId];
    if (branchId) {
      sql += ' AND branch_id = ?';
      params.push(branchId);
    }
    sql += ' ORDER BY suspended_at DESC';

    const sales = db.queryAll(sql, params);
    return sales.map(s => ({
      ...s,
      items: db.queryAll('SELECT * FROM sale_items WHERE sale_id = ?', [s.id])
    }));
  }

  /**
   * Closes cashier shift with cash drawer variance reconciliation.
   */
  static closeShift({ tenantId, shiftId, closingCashKes, notes = '', approvedBy = null }) {
    const shift = db.queryOne('SELECT * FROM shifts WHERE id = ? AND tenant_id = ?', [shiftId, tenantId]);
    if (!shift || shift.status !== 'OPEN') {
      return { success: false, error: 'INVALID_SHIFT', message: 'Shift not found or already closed.' };
    }

    const closingCash = Number(closingCashKes);
    const expectedCash = Number((shift.opening_float_kes + shift.cash_sales_kes).toFixed(2));
    const variance = Number((closingCash - expectedCash).toFixed(2));
    const closedAt = new Date().toISOString();

    db.run(
      `UPDATE shifts
       SET status = 'CLOSED', closed_at = ?, closing_cash_kes = ?, expected_cash_kes = ?, variance_kes = ?, notes = ?, approved_by = ?
       WHERE id = ?`,
      [closedAt, closingCash, expectedCash, variance, notes, approvedBy, shiftId]
    );

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
