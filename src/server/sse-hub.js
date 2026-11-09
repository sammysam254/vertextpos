/**
 * Server-Sent Events (SSE) Real-Time Targeted Notification Hub.
 * Routes instant M-Pesa payment confirmations, auto-print triggers, and queue updates
 * to the exact cashier terminal and register among 30+ simultaneous cashiers.
 */
class SseHub {
  constructor() {
    this.clients = new Set();
  }

  addClient(res, req) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // Parse query params for client targeting
    const parsedUrl = new URL(req.url, 'http://localhost');
    const query = Object.fromEntries(parsedUrl.searchParams.entries());

    res.clientMeta = {
      tenantId: query.tenantId || req.headers['x-tenant-id'] || null,
      branchId: query.branchId || req.headers['x-branch-id'] || null,
      registerId: query.registerId || req.headers['x-register-id'] || null,
      cashierId: query.cashierId || null
    };

    res.write('retry: 3000\n\n');
    res.write(`data: ${JSON.stringify({ type: 'CONNECTED', message: 'Vertext POS SSE Stream Established', meta: res.clientMeta })}\n\n`);

    this.clients.add(res);

    req.on('close', () => {
      this.clients.delete(res);
    });
  }

  /**
   * Delivers an event specifically to the targeted cashier / register.
   */
  sendToTarget(target = {}, eventType, payload) {
    const data = JSON.stringify({
      type: eventType,
      target,
      payload,
      timestamp: new Date().toISOString()
    });

    for (const client of this.clients) {
      const meta = client.clientMeta || {};

      // 1. Tenant filter
      if (target.tenantId && meta.tenantId && meta.tenantId !== 'GLOBAL' && meta.tenantId !== target.tenantId) {
        continue;
      }

      // 2. Register / Till filter (only target register gets targeted print/confirm)
      if (target.registerId && meta.registerId && meta.registerId !== target.registerId) {
        continue;
      }

      // 3. Cashier filter
      if (target.cashierId && meta.cashierId && meta.cashierId !== target.cashierId) {
        continue;
      }

      try {
        client.write(`event: ${eventType}\n`);
        client.write(`data: ${data}\n\n`);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  broadcast(eventType, payload) {
    this.sendToTarget({}, eventType, payload);
  }

  notifyPaymentConfirmed(saleId, mpesaReceipt, amountKes, customerPhone, target = {}) {
    this.sendToTarget(target, 'PAYMENT_CONFIRMED', {
      saleId,
      mpesaReceipt,
      amountKes,
      customerPhone,
      status: 'PAID',
      target,
      message: `M-Pesa Payment ${mpesaReceipt} of KES ${Number(amountKes).toFixed(2)} Confirmed!`
    });
  }

  notifyAutoPrint(saleId, receiptHtml, rawEscPosBase64, target = {}) {
    this.sendToTarget(target, 'PRINT_RECEIPT', {
      saleId,
      receiptHtml,
      rawEscPosBase64,
      target,
      timestamp: new Date().toISOString()
    });
  }
}

module.exports = new SseHub();
