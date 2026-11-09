const { generateQrSvg } = require('./qr-generator');

/**
 * ESC/POS Thermal Printing Subsystem.
 * Generates raw ESC/POS binary streams (58mm/80mm) and high-fidelity visual thermal receipt previews.
 */
class EscPosService {
  /**
   * Generates a visual HTML thermal receipt and raw ESC/POS command array.
   */
  static generateReceipt({
    tenantName = 'MetroMart Supermarkets Ltd',
    tradeName = 'MetroMart Supermarket',
    branchName = 'Nairobi CBD MegaStore',
    branchLocation = 'Moi Avenue, Nairobi',
    branchPhone = '254711002234',
    kraPin = 'P051234567Z',
    receiptNumber,
    saleId,
    cashierName = 'Dave Kipchumba',
    registerCode = 'TILL-01',
    items = [],
    subtotalKes = 0.00,
    taxKes = 0.00,
    totalKes = 0.00,
    paidAmountKes = 0.00,
    changeDueKes = 0.00,
    paymentMethod = 'CASH',
    mpesaReceipt = null,
    customerPhone = null,
    loyaltyPointsEarned = 0,
    loyaltyPointsBalance = 0,
    etimsInfo = null,
    paperWidth = '80MM',
    host = 'localhost:3000',
    logoBase64 = null
  }) {
    const timestamp = new Date().toLocaleString('en-KE', { timeZone: 'Africa/Nairobi' });
    const is80mm = paperWidth === '80MM';
    const cleanSaleId = saleId || `TX-${Date.now().toString().slice(-6)}`;
    const onlineReceiptUrl = `http://${host}/receipt/${cleanSaleId}`;
    const qrSvg = generateQrSvg(onlineReceiptUrl, { size: 110, margin: 1 });

    // 1. Build Visual Thermal Receipt HTML
    let itemsHtml = items.map(item => {
      const vatCode = (item.vat_rate === 0.0 || item.vatRate === 0.0) ? 'B' : 'A';
      return `
        <tr class="receipt-item-row">
          <td colspan="4" class="receipt-item-name">${item.product_name || item.name}</td>
        </tr>
        <tr class="receipt-item-calc">
          <td class="item-qty">${item.quantity} ${item.unit || 'PCS'} @</td>
          <td class="item-price">KES ${(item.unit_price_kes || item.price || 0).toFixed(2)}</td>
          <td class="item-total">KES ${(item.subtotal_kes || item.subtotal || 0).toFixed(2)}</td>
          <td class="item-vat">${vatCode}</td>
        </tr>
      `;
    }).join('');

    const watermarkHtml = logoBase64 ? `<div class="receipt-watermark" style="background-image: url('${logoBase64}');"></div>` : '';
    const logoTopHtml = logoBase64 ? `<div class="receipt-logo-wrap"><img src="${logoBase64}" alt="Logo" class="receipt-top-logo" /></div>` : '';

    const receiptHtml = `
      <div class="thermal-receipt ${is80mm ? 'receipt-80mm' : 'receipt-58mm'}">
        ${watermarkHtml}
        <div class="receipt-header">
          ${logoTopHtml}
          <div class="store-brand-title">${tradeName.toUpperCase()}</div>
          <div class="store-legal-entity">${tenantName}</div>
          <div class="store-meta-line">${branchName} &bull; ${branchLocation}</div>
          <div class="store-meta-line">TEL: ${branchPhone} | KRA PIN: <strong>${kraPin}</strong></div>
        </div>

        <div class="receipt-divider">================================</div>

        <div class="receipt-meta-grid">
          <div>RECEIPT NO: <strong>${receiptNumber || cleanSaleId}</strong></div>
          <div>DATE: ${timestamp}</div>
          <div>REGISTER: <strong>${registerCode}</strong> | CASHIER: ${cashierName}</div>
          ${customerPhone ? `<div>CUSTOMER: ${customerPhone}</div>` : ''}
        </div>

        <div class="receipt-divider">--------------------------------</div>

        <table class="receipt-table">
          <thead>
            <tr>
              <th style="text-align:left;">QTY</th>
              <th style="text-align:right;">PRICE</th>
              <th style="text-align:right;">AMOUNT</th>
              <th style="text-align:center;">TAX</th>
            </tr>
          </thead>
          <tbody>
            ${itemsHtml}
          </tbody>
        </table>

        <div class="receipt-divider">--------------------------------</div>

        <div class="receipt-totals-block">
          <div class="total-line"><span>Net Subtotal:</span> <span>KES ${(subtotalKes - taxKes).toFixed(2)}</span></div>
          <div class="total-line"><span>VAT 16% (Tax A):</span> <span>KES ${taxKes.toFixed(2)}</span></div>
          <div class="total-line"><span>Zero-Rated 0% (Tax B):</span> <span>KES ${(subtotalKes - (taxKes > 0 ? (taxKes / 0.16 * 1.16) : 0)).toFixed(2)}</span></div>
          <div class="total-line grand-total">
            <span>TOTAL AMOUNT:</span>
            <strong>KES ${totalKes.toFixed(2)}</strong>
          </div>
          <div class="total-line payment-line">
            <span>Tender Type:</span>
            <strong>${paymentMethod}</strong>
          </div>
          ${mpesaReceipt ? `<div class="total-line mpesa-line"><span>M-PESA REF:</span> <strong>${mpesaReceipt}</strong></div>` : ''}
          ${paymentMethod === 'CASH' ? `
            <div class="total-line"><span>Cash Tendered:</span> <span>KES ${(paidAmountKes + changeDueKes).toFixed(2)}</span></div>
            <div class="total-line"><span>Change Due:</span> <strong>KES ${changeDueKes.toFixed(2)}</strong></div>
          ` : ''}
        </div>

        ${loyaltyPointsEarned > 0 ? `
          <div class="receipt-divider">--------------------------------</div>
          <div class="loyalty-box">
            <div>Loyalty Points Earned: <strong>+${loyaltyPointsEarned}</strong></div>
            <div>Total Points Balance: <strong>${loyaltyPointsBalance}</strong></div>
          </div>
        ` : ''}

        <div class="receipt-divider">================================</div>

        <!-- KRA eTIMS Fiscal Compliance Block -->
        <div class="receipt-etims-footer">
          <div class="etims-label">*** KRA eTIMS FISCAL RECEIPT ***</div>
          <div>CU SERIAL: <strong>${etimsInfo ? etimsInfo.cuSerialNumber : 'KRA-CU-2026-NBO01'}</strong></div>
          <div>INVOICE NO: ${etimsInfo ? etimsInfo.etimsInvoiceNumber : 'ETIMS/2026/01'}</div>
          <div>INTERNAL DATA SIGNATURE:</div>
          <div class="etims-sig">${etimsInfo ? etimsInfo.signature : '89FA-23BC-019E'}</div>
        </div>

        <!-- ONLINE DIGITAL RECEIPT QR CODE -->
        <div class="receipt-qr-container">
          <div class="qr-svg-frame">${qrSvg}</div>
          <div class="qr-label">SCAN TO VIEW RECEIPT ONLINE</div>
          <div class="qr-url-text">${onlineReceiptUrl}</div>
        </div>

        <div class="receipt-footer-text">
          <p>Thank you for shopping with us!</p>
          <p>Goods once sold can only be exchanged within 7 days with original receipt.</p>
          <div class="powered-by-brand">*** POWERED BY VERTEXT DIGITAL ***</div>
        </div>
      </div>
    `;

    // 2. Generate raw ESC/POS Command Byte Array (Simulation & Base64)
    const rawCommands = [];
    rawCommands.push(0x1B, 0x40); // ESC @ : Initialize
    rawCommands.push(0x1B, 0x61, 0x01); // ESC a 1 : Align center
    rawCommands.push(0x1B, 0x45, 0x01); // ESC E 1 : Bold
    // text header
    const headerStr = `${tradeName.toUpperCase()}\n${branchName}\nTel: ${branchPhone}\n`;
    for (let i = 0; i < headerStr.length; i++) rawCommands.push(headerStr.charCodeAt(i));
    rawCommands.push(0x1B, 0x45, 0x00); // Bold off
    rawCommands.push(0x1D, 0x56, 0x42, 0x00); // GS V B 0 : Cut

    const rawEscPosBase64 = Buffer.from(rawCommands).toString('base64');

    return {
      receiptNumber: receiptNumber || saleId,
      receiptHtml,
      rawEscPosBase64,
      paperWidth,
      timestamp
    };
  }
}

module.exports = EscPosService;

