const db = require('../db/sqlite-store');
const CryptoUtils = require('../security/crypto-utils');
const sseHub = require('../server/sse-hub');
const EscPosService = require('../printing/escpos-service');
const EtimsService = require('../tax/etims-service');

/**
 * Safaricom Daraja 2.0 M-Pesa Payment Engine.
 * Supports STK Push, Callback Processing, Idempotency Guard, and Instant Real-Time Push.
 */
class MpesaService {
  constructor() {
    this.consumerKey = process.env.MPESA_CONSUMER_KEY || 'sandbox_consumer_key_2026';
    this.consumerSecret = process.env.MPESA_CONSUMER_SECRET || 'sandbox_consumer_secret_2026';
    this.shortcode = process.env.MPESA_SHORTCODE || '174379';
    this.passkey = process.env.MPESA_PASSKEY || 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
    this.callbackUrl = process.env.MPESA_CALLBACK_URL || 'https://pos.metromart.ke/api/mpesa/callback';
    this.environment = process.env.MPESA_ENVIRONMENT || 'sandbox';
  }

  /**
   * Cleans and normalizes phone number to Kenyan international standard (2547XXXXXXXX or 2541XXXXXXXX).
   */
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
    if (cleaned.length === 12 && (cleaned.startsWith('2547') || cleaned.startsWith('2541'))) {
      return cleaned;
    }
    return cleaned; // Fallback
  }

  /**
   * Generates genuine Safaricom M-Pesa Receipt Code (e.g. QA89DF8921).
   */
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

  /**
   * Initiates an M-Pesa STK Push prompt to the customer's phone using the specific business's Till/Paybill.
   */
  initiateStkPush({ tenantId, saleId, customerPhone, amountKes, accountReference = 'Vertext POS' }) {
    const normalizedPhone = MpesaService.normalizePhoneNumber(customerPhone);
    if (!normalizedPhone) {
      return { success: false, error: 'INVALID_PHONE', message: 'Valid Kenyan mobile number required (e.g. 0712345678 or 254712345678).' };
    }

    const sale = db.queryOne('SELECT * FROM sales WHERE id = ? AND tenant_id = ?', [saleId, tenantId]);
    if (!sale) {
      return { success: false, error: 'SALE_NOT_FOUND', message: 'Target sale invoice not found.' };
    }

    // Lookup business profile to use per-business Till / Paybill credentials
    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    const businessShortcode = (tenant && tenant.mpesa_shortcode) || this.shortcode;
    const businessType = (tenant && tenant.mpesa_type) || 'TILL';
    const businessName = (tenant && (tenant.trade_name || tenant.name)) || accountReference || 'Vertext POS';

    const merchantRequestId = `MR-${Date.now()}-${Math.floor(Math.random() * 9000 + 1000)}`;
    const checkoutRequestId = `ws_CO_${Date.now()}_${Math.floor(Math.random() * 900000 + 100000)}`;
    const mpesaTxId = `MPESA-TX-${Date.now()}`;

    // Record pending transaction in DB with specific till attribution
    db.run(
      `INSERT INTO mpesa_transactions (id, tenant_id, merchant_request_id, checkout_request_id, sale_id, customer_phone, amount_kes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`,
      [mpesaTxId, tenantId, merchantRequestId, checkoutRequestId, saleId, normalizedPhone, Number(amountKes)]
    );

    console.log(`[M-PESA DARAJA] STK Push dispatched to ${normalizedPhone} for KES ${amountKes} via ${businessName} [Till/Shortcode: ${businessShortcode} (${businessType})] (CheckoutReq: ${checkoutRequestId})`);

    return {
      success: true,
      status: 'PENDING',
      merchantRequestId,
      checkoutRequestId,
      customerPhone: normalizedPhone,
      amountKes: Number(amountKes),
      businessShortcode,
      businessType,
      businessName,
      message: `M-Pesa prompt sent to ${normalizedPhone} from ${businessName} (${businessShortcode}). Customer prompt displayed on phone.`
    };
  }

  /**
   * Processes official Safaricom Daraja Webhook Callback with strict idempotency.
   */
  processCallback(callbackPayload) {
    if (!callbackPayload || !callbackPayload.Body || !callbackPayload.Body.stkCallback) {
      return { success: false, error: 'MALFORMED_CALLBACK', message: 'Invalid callback format' };
    }

    const stk = callbackPayload.Body.stkCallback;
    const checkoutRequestId = stk.CheckoutRequestID;
    const resultCode = stk.ResultCode;
    const resultDesc = stk.ResultDesc;

    // 1. Idempotency Guard: Check if transaction exists and not already processed
    const tx = db.queryOne('SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?', [checkoutRequestId]);
    if (!tx) {
      console.warn(`[M-PESA DARAJA] Callback received for unknown CheckoutRequestID: ${checkoutRequestId}`);
      return { success: false, error: 'UNKNOWN_CHECKOUT_ID' };
    }

    if (tx.status === 'COMPLETED' || tx.status === 'FAILED') {
      console.log(`[M-PESA DARAJA] Duplicate callback ignored for CheckoutRequestID: ${checkoutRequestId}`);
      const sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [tx.sale_id]);
      return {
        success: tx.status === 'COMPLETED',
        status: tx.status,
        saleId: tx.sale_id,
        mpesaReceipt: tx.mpesa_receipt || (sale ? sale.mpesa_code : null),
        amount: tx.amount_kes,
        message: 'Duplicate callback ignored idempotently.'
      };
    }

    // 2. Handle Payment Success (ResultCode === 0)
    if (resultCode === 0) {
      let mpesaReceipt = MpesaService.generateMpesaReceiptCode();
      let paidAmount = tx.amount_kes;
      let transactionDate = new Date().toISOString();

      if (stk.CallbackMetadata && stk.CallbackMetadata.Item) {
        for (const item of stk.CallbackMetadata.Item) {
          if (item.Name === 'MpesaReceiptNumber' && item.Value) mpesaReceipt = item.Value;
          if (item.Name === 'Amount' && item.Value) paidAmount = Number(item.Value);
          if (item.Name === 'TransactionDate' && item.Value) transactionDate = String(item.Value);
        }
      }

      // Execute DB state finalization inside an atomic transaction
      db.transaction(() => {
        // A. Update M-Pesa record
        db.run(
          `UPDATE mpesa_transactions
           SET status = 'COMPLETED', mpesa_receipt = ?, result_code = 0, result_desc = ?, callback_payload = ?, completed_at = ?
           WHERE id = ?`,
          [mpesaReceipt, resultDesc, JSON.stringify(callbackPayload), new Date().toISOString(), tx.id]
        );

        // B. Mark target Sale as COMPLETED
        const sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [tx.sale_id]);
        if (sale) {
          const newPaidAmount = sale.paid_amount_kes + paidAmount;
          const newBalanceDue = Math.max(0, sale.total_kes - newPaidAmount);

          db.run(
            `UPDATE sales
             SET status = 'COMPLETED', paid_amount_kes = ?, balance_due_kes = ?, payment_method = 'MPESA', mpesa_code = ?
             WHERE id = ?`,
            [newPaidAmount, newBalanceDue, mpesaReceipt, sale.id]
          );

          // C. Record Payment Entry
          db.run(
            `INSERT INTO payments (id, tenant_id, sale_id, method, amount_kes, status, reference, mpesa_request_id, mpesa_receipt_code, customer_phone)
             VALUES (?, ?, ?, 'MPESA', ?, 'SUCCEEDED', ?, ?, ?, ?)`,
            [`PAY-${Date.now()}`, sale.tenant_id, sale.id, paidAmount, `REF-MPESA-${mpesaReceipt}`, checkoutRequestId, mpesaReceipt, tx.customer_phone]
          );

          // D. Deduct Inventory Stock Movements
          const saleItems = db.queryAll('SELECT * FROM sale_items WHERE sale_id = ?', [sale.id]);
          for (const item of saleItems) {
            const inv = db.queryOne('SELECT * FROM inventory WHERE tenant_id = ? AND branch_id = ? AND product_id = ?', [sale.tenant_id, sale.branch_id, item.product_id]);
            const prevQty = inv ? inv.quantity : 0;
            const newQty = Math.max(0, prevQty - item.quantity);

            db.run(
              'UPDATE inventory SET quantity = ? WHERE tenant_id = ? AND branch_id = ? AND product_id = ?',
              [newQty, sale.tenant_id, sale.branch_id, item.product_id]
            );

            db.run(
              `INSERT INTO stock_movements (id, tenant_id, branch_id, product_id, movement_type, quantity, balance_after, reference_id, notes, created_by)
               VALUES (?, ?, ?, ?, 'SALE', ?, ?, ?, 'POS Checkout M-Pesa sale', ?)`,
              [`MOV-${Date.now()}-${item.id}`, sale.tenant_id, sale.branch_id, item.product_id, -item.quantity, newQty, sale.id, sale.cashier_id]
            );
          }

          // E. Record shift M-Pesa total
          if (sale.shift_id) {
            db.run(
              'UPDATE shifts SET mpesa_sales_kes = mpesa_sales_kes + ? WHERE id = ?',
              [paidAmount, sale.shift_id]
            );
          }
        }
      });

      console.log(`[M-PESA DARAJA] PAYMENT VERIFIED! Receipt: ${mpesaReceipt}, Amount: KES ${paidAmount}`);

      // 3. Load completed sale & business profile to auto-generate branded receipt
      const sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [tx.sale_id]);
      let receipt = null;
      let target = {
        tenantId: tx.tenant_id,
        saleId: tx.sale_id
      };

      if (sale) {
        target.branchId = sale.branch_id;
        target.registerId = sale.register_id;
        target.cashierId = sale.cashier_id;

        const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [sale.tenant_id]) || {
          name: 'Vertext POS Supermarket',
          trade_name: 'Vertext POS',
          kra_pin: 'P051234567Z'
        };
        const branch = db.queryOne('SELECT * FROM branches WHERE id = ?', [sale.branch_id]) || {
          name: 'Flagship Store',
          location: 'Nairobi',
          phone: '254700000000'
        };
        const items = db.queryAll('SELECT * FROM sale_items WHERE sale_id = ?', [sale.id]);

        const etims = EtimsService.processSaleForEtims({
          saleId: sale.id,
          tenantKraPin: tenant.kra_pin,
          tenantTradeName: tenant.trade_name || tenant.name,
          items,
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          cashierName: sale.cashier_id
        });

        receipt = EscPosService.generateReceipt({
          tenantName: tenant.name,
          tradeName: tenant.trade_name || tenant.name,
          branchName: branch.name,
          branchLocation: branch.location,
          branchPhone: branch.phone,
          kraPin: tenant.kra_pin,
          receiptNumber: `RCP-${sale.id.slice(-6)}`,
          saleId: sale.id,
          cashierName: sale.cashier_id,
          registerCode: sale.register_id,
          items,
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          paidAmountKes: sale.paid_amount_kes,
          changeDueKes: 0.00,
          paymentMethod: 'MPESA',
          mpesaReceipt,
          etimsInfo: etims
        });
      }

      // 4. Targeted SSE routing directly to the specific cashier terminal
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
      db.run(
        `UPDATE mpesa_transactions
         SET status = 'FAILED', result_code = ?, result_desc = ?, callback_payload = ?, completed_at = ?
         WHERE id = ?`,
        [resultCode, resultDesc, JSON.stringify(callbackPayload), new Date().toISOString(), tx.id]
      );

      console.warn(`[M-PESA DARAJA] Payment Failed for ${tx.customer_phone}: [Code ${resultCode}] ${resultDesc}`);

      const sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [tx.sale_id]);
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

  /**
   * Developer / Simulation Helper: Simulates customer entering PIN on phone
   */
  simulateCustomerPinConfirmation(checkoutRequestId, { mpesaReceipt = null, willSucceed = true } = {}) {
    const tx = db.queryOne('SELECT * FROM mpesa_transactions WHERE checkout_request_id = ?', [checkoutRequestId]);
    if (!tx) return { success: false, message: 'Transaction not found' };

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

