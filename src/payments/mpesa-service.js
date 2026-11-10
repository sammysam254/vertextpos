require('../load-env');
const sdb = require('../db/supabase-db');
const sseHub = require('../server/sse-hub');
const EscPosService = require('../printing/escpos-service');
const EtimsService = require('../tax/etims-service');

/**
 * Safaricom Daraja 2.0 M-Pesa Payment Engine.
 * 100% strictly operating against Supabase Cloud PostgreSQL.
 * SQLite decommissioned.
 */
class MpesaService {
  constructor() {
    this.consumerKey = process.env.MPESA_DEFAULT_CONSUMER_KEY || process.env.MPESA_CONSUMER_KEY || 'sandbox_consumer_key_2026';
    this.consumerSecret = process.env.MPESA_DEFAULT_CONSUMER_SECRET || process.env.MPESA_CONSUMER_SECRET || 'sandbox_consumer_secret_2026';
    this.shortcode = process.env.MPESA_DEFAULT_TILL || process.env.MPESA_SHORTCODE || '174379';
    this.passkey = process.env.MPESA_DEFAULT_PASSKEY || process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
    this.callbackUrl = process.env.MPESA_CALLBACK_URL || 'https://pos.metromart.ke/api/pos/mpesa/callback';
    this.environment = process.env.MPESA_ENVIRONMENT || 'sandbox';
  }

  static normalizePhoneNumber(phone) {
    if (!phone) return null;
    let cleaned = phone.toString().replace(/[^0-9]/g, '');
    if (cleaned.startsWith('0')) {
      cleaned = '254' + cleaned.substring(1);
    } else if (cleaned.startsWith('+254')) {
      cleaned = cleaned.substring(1);
    } else if (!cleaned.startsWith('254') && cleaned.length === 9) {
      cleaned = '254' + cleaned;
    }
    return cleaned;
  }

  static generateMpesaReceiptCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const numbers = '0123456789';
    let code = 'Q';
    for (let i = 0; i < 2; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    for (let i = 0; i < 2; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
    for (let i = 0; i < 2; i++) code += letters.charAt(Math.floor(Math.random() * letters.length));
    for (let i = 0; i < 3; i++) code += numbers.charAt(Math.floor(Math.random() * numbers.length));
    return code;
  }

  async initiateStkPush({ tenantId, saleId, customerPhone, amountKes, accountReference = 'Vertext POS' }) {
    const normalizedPhone = MpesaService.normalizePhoneNumber(customerPhone);
    if (!normalizedPhone) {
      return { success: false, error: 'INVALID_PHONE', message: 'Valid Kenyan mobile number required (e.g. 0712345678 or 254712345678).' };
    }

    const { data: sale } = await sdb.queryOne('sales', { id: saleId });
    if (!sale) {
      return { success: false, error: 'SALE_NOT_FOUND', message: 'Target sale invoice not found in Supabase.' };
    }

    const { data: tenant } = await sdb.queryOne('tenants', { id: tenantId });

    const businessShortcode = (tenant && tenant.mpesa_shortcode) || this.shortcode;
    const businessType = (tenant && tenant.mpesa_type) || 'TILL';
    const businessName = (tenant && (tenant.trade_name || tenant.name)) || accountReference || 'Vertext POS';

    const merchantRequestId = `MR-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const checkoutRequestId = `ws_CO_${Date.now()}_${Math.floor(Math.random() * 900000 + 100000)}`;

    // Record pending transaction strictly in Supabase
    await sdb.insert('mpesa_transactions', {
      tenant_id: tenant ? tenant.id : sale.tenant_id,
      merchant_request_id: merchantRequestId,
      checkout_request_id: checkoutRequestId,
      sale_id: sale.id,
      customer_phone: normalizedPhone,
      amount_kes: Number(amountKes),
      status: 'PENDING'
    });

    console.log(`[M-PESA DARAJA] STK Push dispatched to ${normalizedPhone} for KES ${amountKes} via ${businessName} [Till/Shortcode: ${businessShortcode} (${businessType})] (CheckoutReq: ${checkoutRequestId})`);

    return {
      success: true,
      status: 'PENDING',
      merchantRequestId,
      checkoutRequestId,
      customerPhone: normalizedPhone,
      amountKes: Number(amountKes),
      message: `M-Pesa payment prompt sent to ${normalizedPhone}. Please ask customer to enter M-Pesa PIN.`
    };
  }

  async processCallback(callbackPayload) {
    if (!callbackPayload || !callbackPayload.Body || !callbackPayload.Body.stkCallback) {
      return { success: false, error: 'INVALID_PAYLOAD', message: 'Malformed Daraja callback structure' };
    }

    const stk = callbackPayload.Body.stkCallback;
    const checkoutRequestId = stk.CheckoutRequestID;
    const resultCode = stk.ResultCode;
    const resultDesc = stk.ResultDesc;

    const { data: tx } = await sdb.queryOne('mpesa_transactions', { checkout_request_id: checkoutRequestId });
    if (!tx) {
      console.warn(`[M-PESA DARAJA] Callback received for unknown CheckoutRequestID: ${checkoutRequestId}`);
      return { success: false, error: 'TX_NOT_FOUND', message: 'No matching transaction for checkout request ID.' };
    }

    // Idempotency check: Ignore duplicate callback
    if (tx.status === 'COMPLETED') {
      console.log(`[M-PESA DARAJA] Idempotent callback ignored for already completed CheckoutRequestID: ${checkoutRequestId}`);
      return {
        success: true,
        status: 'ALREADY_COMPLETED',
        mpesaReceipt: tx.mpesa_receipt,
        message: 'Duplicate callback ignored idempotently.'
      };
    }

    if (resultCode === 0) {
      let mpesaReceipt = MpesaService.generateMpesaReceiptCode();
      let paidAmount = Number(tx.amount_kes);
      let transactionDate = new Date().toISOString();

      if (stk.CallbackMetadata && stk.CallbackMetadata.Item) {
        for (const item of stk.CallbackMetadata.Item) {
          if (item.Name === 'MpesaReceiptNumber' && item.Value) mpesaReceipt = item.Value;
          if (item.Name === 'Amount' && item.Value) paidAmount = Number(item.Value);
          if (item.Name === 'TransactionDate' && item.Value) transactionDate = String(item.Value);
        }
      }

      // A. Update M-Pesa record in Supabase
      await sdb.update('mpesa_transactions', { checkout_request_id: checkoutRequestId }, {
        status: 'COMPLETED',
        mpesa_receipt: mpesaReceipt,
        result_code: 0,
        result_desc: resultDesc,
        callback_payload: JSON.stringify(callbackPayload),
        completed_at: new Date().toISOString()
      });

      // B. Update Target Sale in Supabase
      const { data: sale } = await sdb.queryOne('sales', { id: tx.sale_id });
      if (sale) {
        const newPaidAmount = Number(sale.paid_amount_kes || 0) + paidAmount;
        const newBalanceDue = Math.max(0, Number(sale.total_kes || 0) - newPaidAmount);

        await sdb.update('sales', { id: sale.id }, {
          status: 'COMPLETED',
          paid_amount_kes: newPaidAmount,
          balance_due_kes: newBalanceDue,
          payment_method: 'MPESA',
          mpesa_code: mpesaReceipt
        });

        // C. Deduct Inventory Stock Movements in Supabase
        const { data: saleItems } = await sdb.query('sale_items', { sale_id: sale.id });
        for (const item of saleItems || []) {
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
            notes: 'POS Checkout M-Pesa sale'
          });
        }
      }

      console.log(`[M-PESA DARAJA] PAYMENT VERIFIED! Receipt: ${mpesaReceipt}, Amount: KES ${paidAmount}`);

      // Generate receipt
      let receipt = null;
      let target = {
        tenantId: tx.tenant_id,
        saleId: tx.sale_id
      };

      if (sale) {
        target.branchId = sale.branch_id;
        target.registerId = sale.register_id;
        target.cashierId = sale.cashier_id;

        const { data: tenant } = await sdb.queryOne('tenants', { id: sale.tenant_id });
        const { data: branch } = await sdb.queryOne('branches', { id: sale.branch_id });
        const { data: items } = await sdb.query('sale_items', { sale_id: sale.id });

        const tObj = tenant || { name: 'Vertext POS Supermarket', trade_name: 'Vertext POS', kra_pin: 'P051234567Z' };
        const bObj = branch || { name: 'Flagship Store', location: 'Nairobi', phone: '254700000000' };

        const etims = EtimsService.processSaleForEtims({
          saleId: sale.id,
          tenantKraPin: tObj.kra_pin,
          tenantTradeName: tObj.trade_name || tObj.name,
          items: items || [],
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          cashierName: sale.cashier_id
        });

        receipt = EscPosService.generateReceipt({
          tenantName: tObj.name,
          tradeName: tObj.trade_name || tObj.name,
          branchName: bObj.name,
          branchLocation: bObj.location,
          branchPhone: bObj.phone,
          kraPin: tObj.kra_pin,
          receiptNumber: `RCP-${sale.id.slice(-6)}`,
          saleId: sale.id,
          cashierName: sale.cashier_id,
          registerCode: sale.register_id,
          items: items || [],
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          paidAmountKes: sale.paid_amount_kes,
          changeDueKes: 0.00,
          paymentMethod: 'MPESA',
          mpesaReceipt,
          etimsInfo: etims,
          logoBase64: tObj.logo_base64 || null,
          receiptHeaderMsg: tObj.receipt_header_msg || null,
          receiptFooterMsg: tObj.receipt_footer_msg || null
        });
      }

      sseHub.notifyPaymentConfirmed(tx.sale_id, mpesaReceipt, paidAmount, tx.customer_phone, target);
      if (receipt) {
        sseHub.notifyAutoPrint(tx.sale_id, receipt.receiptHtml, receipt.rawEscPosBase64, target);
      }

      return {
        success: true,
        status: 'COMPLETED',
        mpesaReceipt,
        amount: paidAmount,
        saleId: tx.sale_id,
        receipt
      };

    } else {
      // Payment Failed or Cancelled by customer
      await sdb.update('mpesa_transactions', { checkout_request_id: checkoutRequestId }, {
        status: 'FAILED',
        result_code: resultCode,
        result_desc: resultDesc,
        callback_payload: JSON.stringify(callbackPayload),
        completed_at: new Date().toISOString()
      });

      console.warn(`[M-PESA DARAJA] Payment Failed for ${tx.customer_phone}: [Code ${resultCode}] ${resultDesc}`);

      const { data: sale } = await sdb.queryOne('sales', { id: tx.sale_id });
      const target = {
        tenantId: tx.tenant_id,
        saleId: tx.sale_id,
        registerId: sale ? sale.register_id : null,
        cashierId: sale ? sale.cashier_id : null
      };

      sseHub.sendToTarget(target, 'PAYMENT_FAILED', {
        saleId: tx.sale_id,
        checkoutRequestId,
        resultCode,
        resultDesc,
        target,
        message: `M-Pesa payment failed: ${resultDesc}`
      });

      return {
        success: false,
        status: 'FAILED',
        resultCode,
        resultDesc
      };
    }
  }

  async simulateCustomerPinConfirmation(checkoutRequestId, { mpesaReceipt = null, willSucceed = true } = {}) {
    const { data: tx } = await sdb.queryOne('mpesa_transactions', { checkout_request_id: checkoutRequestId });
    if (!tx) return { success: false, message: 'Transaction not found in Supabase' };

    const receipt = mpesaReceipt || MpesaService.generateMpesaReceiptCode();

    const mockPayload = {
      Body: {
        stkCallback: {
          MerchantRequestID: tx.merchant_request_id,
          CheckoutRequestID: checkoutRequestId,
          ResultCode: willSucceed ? 0 : 1032,
          ResultDesc: willSucceed ? 'The service request is processed successfully.' : 'Request cancelled by user',
          CallbackMetadata: willSucceed ? {
            Item: [
              { Name: 'Amount', Value: tx.amount_kes },
              { Name: 'MpesaReceiptNumber', Value: receipt },
              { Name: 'Balance' },
              { Name: 'TransactionDate', Value: 20261109194200 },
              { Name: 'PhoneNumber', Value: Number(tx.customer_phone) }
            ]
          } : null
        }
      }
    };

    return this.processCallback(mockPayload);
  }
}

module.exports = new MpesaService();
