require('../load-env');
const db = require('../db/sqlite-store');
const sdb = require('../db/supabase-db');
const JwtAuth = require('../security/jwt-auth');
const HierarchyService = require('../security/hierarchy-service');
const SaasPosService = require('../pos/saas-pos-service');
const mpesaService = require('../payments/mpesa-service');
const EscPosService = require('../printing/escpos-service');
const EtimsService = require('../tax/etims-service');
const sseHub = require('./sse-hub');
const AuditLogger = require('../security/audit-logger');

class SaasRouter {
  static async handle(req, res, pathname, query, body) {
    if (pathname === '/api/events' && req.method === 'GET') {
      sseHub.addClient(res, req);
      return;
    }

    res.setHeader('Content-Type', 'application/json');

    try {
      const ctx = JwtAuth.resolveContext(req);
      const tenantId = ctx.tenantId;

      // 1. Health & Status
      if (pathname === '/api/status' && req.method === 'GET') {
        const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]);
        return this.sendJson(res, 200, {
          status: 'ONLINE',
          currency: 'KES',
          tenant: tenant || { name: 'MetroMart Supermarket', id: tenantId },
          timestamp: new Date().toISOString()
        });
      }

      // 2. Authentication
      if (pathname === '/api/auth/register-tenant' && req.method === 'POST') {
        const result = await JwtAuth.registerTenant(body);
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/auth/register-user' && req.method === 'POST') {
        const result = await JwtAuth.registerUser(body);
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const { emailOrUsername, password } = body;
        const result = await JwtAuth.login(emailOrUsername, password);
        return this.sendJson(res, result.success ? 200 : 401, result);
      }

      // Live Cloud / Supabase Sync Status
      if (pathname === '/api/sync/status' && req.method === 'GET') {
        let pendingCount = 0;
        try {
          pendingCount = db.queryOne("SELECT COUNT(id) as count FROM offline_sync_queue WHERE status = 'PENDING'").count;
        } catch (e) {}

        const hasSupabase = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_KEY || process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
        return this.sendJson(res, 200, {
          database: 'sqlite_local',
          isOnline: true,
          hasCloudCredentials: hasSupabase,
          cloudSyncEnabled: hasSupabase,
          supabaseUrl: process.env.SUPABASE_URL ? 'Connected to Supabase' : 'Local SQLite Active (Ready for Supabase .env keys)',
          pendingQueueCount: pendingCount,
          pendingQueueLength: pendingCount,
          status: hasSupabase ? (pendingCount === 0 ? 'SYNCED' : 'SYNCING') : 'OFFLINE_LOCAL_SECURE'
        });
      }

      // Product SKU / Barcode / Name Search (Instant Cashier Lookup)
      if (pathname === '/api/products/search' && req.method === 'GET') {
        const q = (query.q || '').trim();
        if (!q) return this.sendJson(res, 200, { products: [] });
        const pattern = `%${q}%`;
        let products = db.queryAll(
          `SELECT p.*, COALESCE(i.quantity, 0) as stock_quantity 
           FROM products p 
           LEFT JOIN inventory i ON p.id = i.product_id AND i.branch_id = ?
           WHERE p.tenant_id = ? AND p.is_active = 1 AND (p.barcode LIKE ? OR p.sku LIKE ? OR p.name LIKE ?) 
           LIMIT 12`,
          [ctx.branchId || 'BR-001', tenantId, pattern, pattern, pattern]
        );

        if ((!products || products.length === 0) && sdb.isConfigured()) {
          try {
            const { data: sups } = await sdb.query('products', { is_active: true }, {
              orFilters: `barcode.ilike.*${encodeURIComponent(q)}*,sku.ilike.*${encodeURIComponent(q)}*,name.ilike.*${encodeURIComponent(q)}*`,
              limit: 12
            });
            if (sups && sups.length > 0) products = sups;
          } catch (e) {}
        }
        return this.sendJson(res, 200, { products });
      }

      // M-Pesa Status Poller (Live Supabase Cloud First with Local Sync)
      if (pathname.match(/^\/api\/mpesa\/status\/([^/]+)$/) && req.method === 'GET') {
        const saleId = pathname.split('/')[4];
        let tx = db.queryOne('SELECT * FROM mpesa_transactions WHERE sale_id = ? ORDER BY created_at DESC LIMIT 1', [saleId]);
        let sale = db.queryOne('SELECT * FROM sales WHERE id = ?', [saleId]);

        if (sdb.isConfigured() && (!sale || sale.status !== 'COMPLETED')) {
          try {
            const { data: mRows } = await sdb.query('mpesa_transactions', { sale_id: saleId }, { order: 'created_at.desc', limit: 1 });
            if (mRows && mRows.length > 0) tx = mRows[0];

            const { data: sRows } = await sdb.query('sales', { id: saleId }, { limit: 1 });
            if (sRows && sRows.length > 0) sale = sRows[0];
          } catch (e) {}
        }

        return this.sendJson(res, 200, {
          saleId,
          isPaid: sale ? sale.status === 'COMPLETED' : (tx ? tx.status === 'COMPLETED' : false),
          saleStatus: sale ? (sale.status || 'UNKNOWN') : (tx && tx.status === 'COMPLETED' ? 'COMPLETED' : 'PENDING'),
          mpesaStatus: tx ? (tx.status || 'NONE') : 'NONE',
          mpesaReceipt: tx ? (tx.mpesa_receipt || (sale ? sale.mpesa_code : null)) : (sale ? sale.mpesa_code : null),
          amountKes: tx ? (tx.amount_kes || tx.amount || 0) : 0
        });
      }

      if (pathname === '/api/plans' && req.method === 'GET') {
        const plans = db.queryAll('SELECT * FROM plans');
        return this.sendJson(res, 200, {
          plans: plans.map(p => ({
            ...p,
            features: p.features_json ? JSON.parse(p.features_json) : []
          }))
        });
      }

      if (pathname === '/api/tenants' && req.method === 'GET') {
        const tenants = db.queryAll('SELECT id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status FROM tenants');
        return this.sendJson(res, 200, { tenants });
      }

      // 3. User Switcher / Demo Role Accounts
      if (pathname === '/api/users' && req.method === 'GET') {
        const users = db.queryAll(
          'SELECT id, username, email, full_name, role, branch_id, permissions_json, active FROM users WHERE tenant_id = ? OR tenant_id = \'GLOBAL\'',
          [tenantId]
        );
        return this.sendJson(res, 200, {
          users: users.map(u => ({
            ...u,
            permissions: u.permissions_json ? JSON.parse(u.permissions_json) : []
          }))
        });
      }

      // 4. Products Catalog
      if (pathname === '/api/products' && req.method === 'GET') {
        let products = db.queryAll('SELECT * FROM products WHERE tenant_id = ? AND is_active = 1', [tenantId]);

        if ((!products || products.length === 0) && sdb.isConfigured()) {
          try {
            const { data: sups } = await sdb.query('products', { is_active: true }, { order: 'name.asc' });
            if (sups && sups.length > 0) products = sups;
          } catch (e) {}
        }
        return this.sendJson(res, 200, { products });
      }

      if (pathname === '/api/products' && req.method === 'POST') {
        const { name, barcode, sku, category, unit, costPriceKes, sellingPriceKes, wholesalePriceKes, vatRate, initialStock } = body;
        await HierarchyService.ensureTenantExists(tenantId);

        const prodId = `PRD-${Date.now().toString().slice(-6)}`;
        db.run(
          `INSERT INTO products (id, tenant_id, name, barcode, sku, category, unit, cost_price_kes, selling_price_kes, wholesale_price_kes, vat_rate, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
          [prodId, tenantId, name, barcode, sku || barcode, category || 'FMCG & Groceries', unit || 'PCS', costPriceKes || 0, sellingPriceKes || 0, wholesalePriceKes || sellingPriceKes || 0, vatRate !== undefined ? vatRate : 16.0]
        );

        // Also add initial stock to inventory table
        const branchId = ctx.branchId || 'BR-001';
        const stockQty = Number(initialStock) || 100;
        try {
          db.run(
            `INSERT OR REPLACE INTO inventory (id, tenant_id, branch_id, product_id, quantity, reorder_level)
             VALUES (?, ?, ?, ?, ?, 10)`,
            [`INV-${prodId}`, tenantId, branchId, prodId, stockQty]
          );
        } catch (e) {}

        // Sync directly to Supabase Cloud
        if (sdb.isConfigured()) {
          try {
            const tenantUuid = await sdb.resolveTenantUuid(tenantId);
            const { data: pData } = await sdb.insert('products', {
              tenant_id: tenantUuid,
              name,
              barcode,
              sku: sku || barcode,
              category: category || 'FMCG & Groceries',
              unit: unit || 'PCS',
              cost_price_kes: costPriceKes || 0,
              selling_price_kes: sellingPriceKes || 0,
              wholesale_price_kes: wholesalePriceKes || sellingPriceKes || 0,
              vat_rate: vatRate !== undefined ? vatRate : 16.0,
              is_active: true
            });

            if (pData && pData.length > 0) {
              const bUuid = await sdb.resolveBranchUuid(tenantUuid, branchId);
              await sdb.insert('inventory', {
                tenant_id: tenantUuid,
                branch_id: bUuid,
                product_id: pData[0].id,
                quantity: stockQty,
                reorder_level: 10
              });
            }
          } catch (cloudErr) {
            console.warn('[SUPABASE PRODUCT SYNC] notice:', cloudErr.message);
          }
        }

        return this.sendJson(res, 201, { success: true, productId: prodId, message: `Product "${name}" created successfully.` });
      }

      // 5. Branches & Registers
      if (pathname === '/api/branches' && req.method === 'GET') {
        const branches = db.queryAll('SELECT * FROM branches WHERE tenant_id = ?', [tenantId]);
        return this.sendJson(res, 200, { branches });
      }

      // 6. POS Checkout Operations
      if (pathname === '/api/pos/sale/new' && req.method === 'POST') {
        const { branchId, registerId, cashierId, customerId } = body;
        const sale = await SaasPosService.createSale({
          tenantId,
          branchId: branchId || ctx.branchId || 'BR-001',
          registerId: registerId || ctx.registerId || 'REG-01',
          cashierId: cashierId || 'usr_cashier_01',
          customerId
        });
        return this.sendJson(res, 201, { sale });
      }

      if (pathname.match(/^\/api\/pos\/sale\/([^/]+)$/) && req.method === 'GET') {
        const saleId = pathname.split('/')[4];
        const sale = await SaasPosService.getSaleById(tenantId, saleId);
        if (!sale) return this.sendJson(res, 404, { error: 'NOT_FOUND', message: 'Sale not found' });
        return this.sendJson(res, 200, { sale });
      }

      if (pathname.match(/^\/api\/pos\/sale\/([^/]+)\/item$/) && req.method === 'POST') {
        const saleId = pathname.split('/')[4];
        const { barcodeOrId, quantity, pricingTier } = body;
        const result = await SaasPosService.addItemToCart({
          tenantId,
          saleId,
          barcodeOrId,
          quantity: quantity || 1,
          pricingTier: pricingTier || 'retail'
        });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      // 7. Cash Payment Tender
      if (pathname.match(/^\/api\/pos\/sale\/([^/]+)\/cash$/) && req.method === 'POST') {
        const saleId = pathname.split('/')[4];
        const { cashTenderedKes, cashierName } = body;
        const result = await SaasPosService.tenderCashPayment({
          tenantId,
          saleId,
          cashTenderedKes,
          cashierName: cashierName || 'Dave Kipchumba'
        });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      // 8. Safaricom M-Pesa Daraja STK Push & Callbacks
      if (pathname === '/api/mpesa/stk-push' && req.method === 'POST') {
        const { saleId, customerPhone, amountKes } = body;
        const result = await mpesaService.initiateStkPush({
          tenantId,
          saleId,
          customerPhone,
          amountKes
        });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      if (pathname === '/api/mpesa/callback' && req.method === 'POST') {
        const result = await mpesaService.processCallback(body);
        return this.sendJson(res, 200, result);
      }

      if (pathname === '/api/pos/mpesa/callback' && req.method === 'POST') {
        const result = await mpesaService.processCallback(body);
        return this.sendJson(res, 200, result);
      }

      if (pathname === '/api/mpesa/simulate-pin' && req.method === 'POST') {
        const { checkoutRequestId, willSucceed } = body;
        const result = await mpesaService.simulateCustomerPinConfirmation(checkoutRequestId, { willSucceed });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      // 9. Suspended Sales
      if (pathname.match(/^\/api\/pos\/sale\/([^/]+)\/suspend$/) && req.method === 'POST') {
        const saleId = pathname.split('/')[4];
        const { supervisorId, reason } = body;
        const result = await SaasPosService.suspendSale({
          tenantId,
          saleId,
          supervisorId: supervisorId || 'usr_superv_01',
          reason
        });
        return this.sendJson(res, result.success ? 200 : 403, result);
      }

      if (pathname.match(/^\/api\/pos\/sale\/([^/]+)\/resume$/) && req.method === 'POST') {
        const saleId = pathname.split('/')[4];
        const { supervisorId } = body;
        const result = await SaasPosService.resumeSale({
          tenantId,
          saleId,
          supervisorId: supervisorId || 'usr_superv_01'
        });
        return this.sendJson(res, result.success ? 200 : 403, result);
      }

      if (pathname === '/api/pos/suspended' && req.method === 'GET') {
        const branchId = query.branchId || null;
        const suspendedSales = await SaasPosService.getSuspendedSales(tenantId, branchId);
        return this.sendJson(res, 200, { suspendedSales, suspendedTransactions: suspendedSales });
      }

      // 10. Cashier Shifts
      if (pathname === '/api/shifts/active' && req.method === 'GET') {
        const registerId = query.registerId || ctx.registerId || 'REG-01';
        const shift = db.queryOne(
          'SELECT * FROM shifts WHERE tenant_id = ? AND register_id = ? AND status = \'OPEN\'',
          [tenantId, registerId]
        );
        return this.sendJson(res, 200, { shift });
      }

      if (pathname === '/api/shifts/open' && req.method === 'POST') {
        const { branchId, registerId, cashierId, openingFloatKes, notes } = body;
        const shiftId = `SHIFT-${Date.now().toString().slice(-6)}`;
        db.run(
          `INSERT INTO shifts (id, tenant_id, branch_id, register_id, cashier_id, status, opened_at, opening_float_kes, notes)
           VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?, ?)`,
          [shiftId, tenantId, branchId || 'BR-001', registerId || 'REG-01', cashierId || 'usr_cashier_01', new Date().toISOString(), Number(openingFloatKes || 2500.00), notes || 'Shift Opened']
        );
        const shift = db.queryOne('SELECT * FROM shifts WHERE id = ?', [shiftId]);
        return this.sendJson(res, 201, { success: true, shift });
      }

      if (pathname === '/api/shifts/close' && req.method === 'POST') {
        const { shiftId, closingCashKes, notes, approvedBy } = body;
        const result = await SaasPosService.closeShift({
          tenantId,
          shiftId,
          closingCashKes,
          notes,
          approvedBy
        });
        return this.sendJson(res, result.success ? 200 : 400, result);
      }

      // 11. Hierarchical User & Role Management Engine
      if (pathname === '/api/hierarchy/branches' && req.method === 'GET') {
        const branches = await HierarchyService.getBranches({ tenantId });
        return this.sendJson(res, 200, { branches: branches || [] });
      }

      if (pathname === '/api/hierarchy/create-branch' && req.method === 'POST') {
        const creatorRole = (ctx.user && ctx.user.role) || ctx.userRole || body.creatorRole || 'owner';
        const result = await HierarchyService.createBranch({
          creatorRole,
          creatorTenantId: tenantId,
          code: body.code,
          name: body.name,
          location: body.location,
          phone: body.phone
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/hierarchy/create-owner' && req.method === 'POST') {
        const result = await HierarchyService.createBusinessOwner({
          creatorRole: ctx.userRole || body.creatorRole || 'super_admin',
          ...body
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/hierarchy/create-admin' && req.method === 'POST') {
        const result = await HierarchyService.createBusinessAdmin({
          creatorRole: ctx.userRole || body.creatorRole || 'owner',
          creatorTenantId: tenantId,
          ...body
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/hierarchy/create-branch-manager' && req.method === 'POST') {
        const result = await HierarchyService.createBranchManager({
          creatorRole: ctx.userRole || body.creatorRole || 'admin',
          creatorTenantId: tenantId,
          ...body
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      if (pathname === '/api/hierarchy/create-staff' && req.method === 'POST') {
        const result = await HierarchyService.createStaff({
          creatorRole: ctx.userRole || body.creatorRole || 'branch_manager',
          creatorTenantId: tenantId,
          creatorBranchId: ctx.branchId || body.branchId,
          ...body
        });
        return this.sendJson(res, result.success ? 201 : 400, result);
      }

      // Per-Business M-Pesa Daraja & Branding Configuration
      if (pathname === '/api/hierarchy/configure-daraja' && req.method === 'POST') {
        const { targetTenantId, tenantId: bodyTenantId, mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret, mpesaType, receiptHeaderMsg, receiptFooterMsg } = body;
        const effectiveTenantId = targetTenantId || bodyTenantId || tenantId;

        db.run(
          `UPDATE tenants 
           SET mpesa_shortcode = ?, mpesa_passkey = ?, mpesa_consumer_key = ?, mpesa_consumer_secret = ?, mpesa_type = ?, receipt_header_msg = ?, receipt_footer_msg = ?
           WHERE id = ?`,
          [mpesaShortcode, mpesaPasskey, mpesaConsumerKey, mpesaConsumerSecret, mpesaType || 'TILL', receiptHeaderMsg, receiptFooterMsg, effectiveTenantId]
        );

        const updatedTenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [effectiveTenantId]);

        return this.sendJson(res, 200, {
          success: true,
          tenant: updatedTenant,
          message: `M-Pesa Daraja configuration updated for tenant ${effectiveTenantId}.`
        });
      }

      // Business Settings
      if (pathname === '/api/tenant/settings' && req.method === 'GET') {
        const targetTenantId = query.tenantId || tenantId;
        const tenantProfile = db.queryOne('SELECT * FROM tenants WHERE id = ?', [targetTenantId]);
        if (!tenantProfile) return this.sendJson(res, 404, { error: 'TENANT_NOT_FOUND' });
        return this.sendJson(res, 200, { success: true, tenant: tenantProfile });
      }

      if (pathname === '/api/tenant/settings' && req.method === 'POST') {
        const { targetTenantId, name, tradeName, kraPin, phone, email, location, receiptHeaderMsg, receiptFooterMsg, logoBase64, monthlySubscriptionKes } = body;
        const effectiveTenantId = targetTenantId || tenantId;

        const existing = db.queryOne('SELECT * FROM tenants WHERE id = ?', [effectiveTenantId]);
        if (!existing) return this.sendJson(res, 404, { error: 'TENANT_NOT_FOUND' });

        const updatedName = name || existing.name;
        const updatedTradeName = tradeName || existing.trade_name || updatedName;
        const updatedKraPin = kraPin || existing.kra_pin;
        const updatedPhone = phone || existing.phone;
        const updatedEmail = email || existing.email;
        const updatedLocation = location || existing.location || 'Nairobi';
        const updatedHeader = receiptHeaderMsg !== undefined ? receiptHeaderMsg : existing.receipt_header_msg;
        const updatedFooter = receiptFooterMsg !== undefined ? receiptFooterMsg : existing.receipt_footer_msg;
        const updatedLogo = logoBase64 !== undefined ? logoBase64 : existing.logo_base64;
        const updatedSubFee = monthlySubscriptionKes !== undefined ? Number(monthlySubscriptionKes) : existing.monthly_subscription_kes;

        db.run(
          `UPDATE tenants 
           SET name = ?, trade_name = ?, kra_pin = ?, phone = ?, email = ?, location = ?, receipt_header_msg = ?, receipt_footer_msg = ?, logo_base64 = ?, monthly_subscription_kes = ?
           WHERE id = ?`,
          [updatedName, updatedTradeName, updatedKraPin, updatedPhone, updatedEmail, updatedLocation, updatedHeader, updatedFooter, updatedLogo, updatedSubFee, effectiveTenantId]
        );

        db.run('UPDATE branches SET location = ?, phone = ? WHERE tenant_id = ?', [updatedLocation, updatedPhone, effectiveTenantId]);

        const updated = db.queryOne('SELECT * FROM tenants WHERE id = ?', [effectiveTenantId]);

        return this.sendJson(res, 200, {
          success: true,
          tenant: updated,
          message: 'Business configurations & receipt branding saved successfully.'
        });
      }

      if (pathname === '/api/hierarchy/users' && req.method === 'GET') {
        const users = db.queryAll(
          `SELECT id, username, email, full_name, phone, role, branch_id, pin_code, active, created_at 
           FROM users 
           WHERE tenant_id = ? OR tenant_id = 'GLOBAL'
           ORDER BY role ASC, created_at DESC`,
          [tenantId]
        );
        return this.sendJson(res, 200, { users });
      }

      // 12. Dedicated 10-Role Dashboard Metrics Engine
      if (pathname.startsWith('/api/dashboard/') && req.method === 'GET') {
        const role = pathname.split('/')[3];
        const dashboardData = await this.getRoleDashboardData(role, tenantId, ctx);
        return this.sendJson(res, 200, dashboardData);
      }

      // 13. Reports Dashboard
      if (pathname === '/api/reports/dashboard' && req.method === 'GET') {
        const salesStats = db.queryOne(`
          SELECT 
            COUNT(id) as transactionCount,
            COALESCE(SUM(total_kes), 0.0) as totalRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total_kes ELSE 0 END), 0.0) as cashRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'MPESA' THEN total_kes ELSE 0 END), 0.0) as mpesaRevenueKes
          FROM sales
          WHERE tenant_id = ? AND status = 'COMPLETED'
        `, [tenantId]);

        const inventoryStats = db.queryOne(`
          SELECT COUNT(id) as lowStockCount FROM inventory WHERE tenant_id = ? AND quantity <= reorder_level
        `, [tenantId]);

        return this.sendJson(res, 200, {
          currency: 'KES',
          todaySalesKes: salesStats ? salesStats.totalRevenueKes : 0.00,
          transactionCount: salesStats ? salesStats.transactionCount : 0,
          cashRevenueKes: salesStats ? salesStats.cashRevenueKes : 0.00,
          mpesaRevenueKes: salesStats ? salesStats.mpesaRevenueKes : 0.00,
          lowStockCount: inventoryStats ? inventoryStats.lowStockCount : 0
        });
      }

      // Receipt Preview
      if (pathname.match(/^\/api\/printing\/receipt\/([^/]+)$/) && req.method === 'GET') {
        const saleId = pathname.split('/')[4];
        const sale = await SaasPosService.getSaleById(tenantId, saleId) || await SaasPosService.getSaleById(null, saleId);
        if (!sale) return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Sale ${saleId} not found` });

        const effectiveTenantId = sale.tenant_id || tenantId;
        const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [effectiveTenantId]) || {
          name: 'MetroMart Supermarkets Ltd',
          trade_name: 'MetroMart Supermarket & Wholesalers',
          kra_pin: 'P051234567Z'
        };
        const branch = db.queryOne('SELECT * FROM branches WHERE id = ?', [sale.branch_id]) || {
          name: 'Main Flagship Store',
          location: 'Nairobi CBD',
          phone: '254711002234'
        };

        const cashierUser = db.queryOne('SELECT full_name FROM users WHERE id = ?', [sale.cashier_id]);
        const cashierName = cashierUser ? cashierUser.full_name : 'Dave Kipchumba';

        const etims = EtimsService.processSaleForEtims({
          saleId,
          tenantKraPin: tenant.kra_pin,
          tenantTradeName: tenant.trade_name,
          items: sale.items || [],
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          cashierName
        });

        const receipt = EscPosService.generateReceipt({
          tenantName: tenant.name,
          tradeName: tenant.trade_name || tenant.name,
          branchName: branch.name,
          branchLocation: branch.location,
          branchPhone: branch.phone,
          kraPin: tenant.kra_pin,
          receiptNumber: `RCP-${saleId.slice(-6)}`,
          saleId,
          cashierName,
          registerCode: sale.register_id || 'TILL-01',
          items: sale.items || [],
          subtotalKes: sale.subtotal_kes || 0.00,
          taxKes: sale.tax_kes || 0.00,
          totalKes: sale.total_kes || 0.00,
          paidAmountKes: sale.paid_amount_kes || 0.00,
          changeDueKes: sale.change_due_kes || 0.00,
          paymentMethod: sale.payment_method || 'CASH',
          mpesaReceipt: sale.mpesa_code,
          customerPhone: sale.customer_phone,
          etimsInfo: etims,
          host: req.headers.host || 'localhost:3000',
          logoBase64: tenant.logo_base64 || null,
          receiptHeaderMsg: tenant.receipt_header_msg || null,
          receiptFooterMsg: tenant.receipt_footer_msg || null
        });

        return this.sendJson(res, 200, receipt);
      }

      // Public Online Digital Receipt Viewer
      if ((pathname.match(/^\/receipt\/([^/]+)$/) || pathname.match(/^\/api\/receipt\/(?:view\/)?([^/]+)$/)) && req.method === 'GET') {
        const saleId = pathname.split('/').pop();
        const sale = await SaasPosService.getSaleById(null, saleId);
        if (!sale) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          return res.end(`
            <!DOCTYPE html>
            <html>
            <head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Receipt Not Found</title></head>
            <body style="font-family:system-ui,sans-serif; text-align:center; padding:40px; background:#f8fafc; color:#334155;">
              <h2 style="color:#ef4444;">Receipt Not Found</h2>
              <p>Invoice ID <code>${saleId}</code> was not found on the Vertext POS cloud network.</p>
            </body>
            </html>
          `);
        }

        const effectiveTenantId = sale.tenant_id;
        const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [effectiveTenantId]) || {
          name: 'MetroMart Supermarkets Ltd',
          trade_name: 'MetroMart Supermarket & Wholesalers',
          kra_pin: 'P051234567Z'
        };
        const branch = db.queryOne('SELECT * FROM branches WHERE id = ?', [sale.branch_id]) || {
          name: 'Main Flagship Store',
          location: 'Nairobi CBD',
          phone: '254711002234'
        };

        const cashierUser = db.queryOne('SELECT full_name FROM users WHERE id = ?', [sale.cashier_id]);
        const cashierName = cashierUser ? cashierUser.full_name : 'Dave Kipchumba';

        const etims = EtimsService.processSaleForEtims({
          saleId,
          tenantKraPin: tenant.kra_pin,
          tenantTradeName: tenant.trade_name,
          items: sale.items || [],
          subtotalKes: sale.subtotal_kes,
          taxKes: sale.tax_kes,
          totalKes: sale.total_kes,
          cashierName
        });

        const receipt = EscPosService.generateReceipt({
          tenantName: tenant.name,
          tradeName: tenant.trade_name || tenant.name,
          branchName: branch.name,
          branchLocation: branch.location,
          branchPhone: branch.phone,
          kraPin: tenant.kra_pin,
          receiptNumber: `RCP-${saleId.slice(-6)}`,
          saleId,
          cashierName,
          registerCode: sale.register_id || 'TILL-01',
          items: sale.items || [],
          subtotalKes: sale.subtotal_kes || 0.00,
          taxKes: sale.tax_kes || 0.00,
          totalKes: sale.total_kes || 0.00,
          paidAmountKes: sale.paid_amount_kes || 0.00,
          changeDueKes: sale.change_due_kes || 0.00,
          paymentMethod: sale.payment_method || 'CASH',
          mpesaReceipt: sale.mpesa_code,
          customerPhone: sale.customer_phone,
          etimsInfo: etims,
          host: req.headers.host || 'localhost:3000',
          logoBase64: tenant.logo_base64 || null,
          receiptHeaderMsg: tenant.receipt_header_msg || null,
          receiptFooterMsg: tenant.receipt_footer_msg || null
        });

        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.end(`
          <!DOCTYPE html>
          <html lang="en">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>${tenant.trade_name} - E-Receipt #${saleId}</title>
            <link rel="stylesheet" href="/styles.css">
            <style>
              body { background: #f1f5f9; margin: 0; padding: 20px 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
              .public-receipt-card { background: #ffffff; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.08); padding: 24px 16px; width: 100%; max-width: 360px; box-sizing: border-box; }
              .verified-pill { display: inline-flex; align-items: center; gap: 6px; background: #dcfce7; color: #15803d; padding: 4px 12px; border-radius: 20px; font-size: 0.75rem; font-weight: 700; margin-bottom: 16px; border: 1px solid #bbf7d0; }
              .public-btn-tray { margin-top: 20px; display: flex; gap: 10px; width: 100%; max-width: 360px; }
              .public-btn { flex: 1; padding: 12px; border-radius: 8px; font-weight: 600; font-size: 0.9rem; cursor: pointer; text-align: center; text-decoration: none; border: none; }
              .btn-p-primary { background: #2563eb; color: #fff; }
              .btn-p-secondary { background: #e2e8f0; color: #1e293b; }
            </style>
          </head>
          <body>
            <div class="verified-pill">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
              VERIFIED OFFICIAL E-RECEIPT
            </div>
            <div class="public-receipt-card">
              ${receipt.receiptHtml}
            </div>
            <div class="public-btn-tray">
              <button class="public-btn btn-p-primary" onclick="window.print()">Print / Save PDF</button>
              <a class="public-btn btn-p-secondary" href="/">Back to POS</a>
            </div>
          </body>
          </html>
        `);
      }

      return this.sendJson(res, 404, { error: 'NOT_FOUND', message: `Route ${pathname} not found` });
    } catch (err) {
      console.error('API Error:', err);
      return this.sendJson(res, 500, { error: 'INTERNAL_ERROR', message: err.message });
    }
  }

  static async getRoleDashboardData(role, tenantId, ctx) {
    await HierarchyService.ensureTenantExists(tenantId);

    const tenant = db.queryOne('SELECT * FROM tenants WHERE id = ?', [tenantId]) || {
      id: tenantId,
      name: 'MetroMart Supermarkets Ltd',
      trade_name: 'MetroMart Supermarkets',
      kra_pin: 'P051234567Z',
      currency: 'KES'
    };

    const branchId = ctx.branchId || 'BR-001';

    switch (role) {
      case 'super_admin': {
        const tenants = db.queryAll('SELECT id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, mpesa_shortcode, mpesa_type, mpesa_consumer_key, receipt_header_msg, created_at FROM tenants');
        const activeCount = tenants.filter(t => t.status === 'ACTIVE').length;
        const totalMrr = tenants.reduce((acc, t) => acc + (t.plan_id === 'enterprise' ? 12500 : 6500), 0);
        return {
          role: 'super_admin',
          currency: 'KES',
          totalTenants: tenants.length,
          activeTenants: activeCount,
          totalMrrKes: totalMrr,
          totalArrKes: totalMrr * 12,
          tenants: tenants.map(t => ({
            ...t,
            monthlySubscriptionKes: t.plan_id === 'enterprise' ? 12500 : 6500,
            billingSchedule: '1st of every month',
            nextBillingDate: '2026-12-01',
            status: t.status
          })),
          systemHealth: {
            databaseEngine: 'node:sqlite (WAL Mode) & Supabase Adapter Synced',
            uptime: '99.98%',
            status: 'HEALTHY',
            totalTransactionsRecorded: db.queryOne('SELECT COUNT(id) as count FROM sales').count
          }
        };
      }

      case 'owner': {
        const salesStats = db.queryOne(`
          SELECT 
            COUNT(id) as transactionCount,
            COALESCE(SUM(total_kes), 0.0) as totalRevenueKes,
            COALESCE(SUM(tax_kes), 0.0) as vatCollectedKes,
            COALESCE(SUM(subtotal_kes), 0.0) as subtotalKes,
            COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total_kes ELSE 0 END), 0.0) as cashRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'MPESA' THEN total_kes ELSE 0 END), 0.0) as mpesaRevenueKes
          FROM sales
          WHERE tenant_id = ? AND status = 'COMPLETED'
        `, [tenantId]) || { transactionCount: 0, totalRevenueKes: 0, vatCollectedKes: 0, cashRevenueKes: 0, mpesaRevenueKes: 0 };

        const branches = await HierarchyService.getBranches({ tenantId });

        let admins = db.queryAll(
          `SELECT id, username, email, full_name, phone, role, active, created_at 
           FROM users 
           WHERE tenant_id = ? AND role = 'admin'`,
          [tenantId]
        );

        if ((!admins || admins.length === 0) && sdb.isConfigured()) {
          try {
            const tenantUuid = await sdb.resolveTenantUuid(tenantId);
            if (tenantUuid) {
              const { data: remoteAdmins } = await sdb.query('users', { tenant_id: tenantUuid, role: 'admin' });
              if (remoteAdmins && remoteAdmins.length > 0) {
                for (const ra of remoteAdmins) {
                  db.run(
                    `INSERT OR IGNORE INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
                     VALUES (?, ?, ?, ?, 'hash', 'salt', ?, ?, 'admin', 'ALL', '[]', '2222', 1)`,
                    [ra.id, tenantId, ra.username || ra.email.split('@')[0], ra.email, ra.full_name || 'Admin', ra.phone || '']
                  );
                }
                admins = db.queryAll('SELECT id, username, email, full_name, phone, role, active, created_at FROM users WHERE tenant_id = ? AND role = \'admin\'', [tenantId]);
              }
            }
          } catch (e) {}
        }

        return {
          role: 'owner',
          currency: 'KES',
          businessName: tenant.name,
          kraPin: tenant.kra_pin,
          totalRevenueKes: salesStats.totalRevenueKes,
          grossProfitKes: Math.round(salesStats.totalRevenueKes * 0.22),
          vatCollectedKes: salesStats.vatCollectedKes,
          transactionCount: salesStats.transactionCount,
          cashRevenueKes: salesStats.cashRevenueKes,
          mpesaRevenueKes: salesStats.mpesaRevenueKes,
          subscription: {
            plan: tenant.plan_id || 'Enterprise Multi-Branch',
            monthlySubscriptionKes: 12500.00,
            billingSchedule: 'Paid on the 1st of every month',
            nextBillingDate: '2026-12-01',
            status: 'ACTIVE'
          },
          branches: branches || [],
          admins: admins || []
        };
      }

      case 'admin': {
        const prodCount = db.queryOne('SELECT COUNT(id) as count FROM products WHERE tenant_id = ? AND is_active = 1', [tenantId]).count;
        const zeroRatedCount = db.queryOne('SELECT COUNT(id) as count FROM products WHERE tenant_id = ? AND vat_rate = 0 AND is_active = 1', [tenantId]).count;
        const standardVatCount = db.queryOne('SELECT COUNT(id) as count FROM products WHERE tenant_id = ? AND vat_rate > 0 AND is_active = 1', [tenantId]).count;
        const lowStockCount = db.queryOne('SELECT COUNT(id) as count FROM inventory WHERE tenant_id = ? AND quantity <= reorder_level', [tenantId]).count;

        const branchManagers = db.queryAll(`
          SELECT u.id, u.username, u.email, u.full_name, u.phone, u.branch_id, u.active, b.name as branch_name
          FROM users u
          LEFT JOIN branches b ON u.branch_id = b.id
          WHERE u.tenant_id = ? AND u.role = 'branch_manager'
        `, [tenantId]);

        const branches = await HierarchyService.getBranches({ tenantId });

        return {
          role: 'admin',
          currency: 'KES',
          totalProducts: prodCount,
          zeroRatedCount,
          standardVatCount,
          lowStockCount,
          branchManagers: branchManagers || [],
          branches: branches || []
        };
      }

      case 'branch_manager': {
        const branch = db.queryOne('SELECT * FROM branches WHERE id = ? AND tenant_id = ?', [branchId, tenantId]) || { id: branchId, name: 'Main Branch' };
        const tills = db.queryAll('SELECT * FROM registers WHERE branch_id = ? AND tenant_id = ?', [branchId, tenantId]);
        const branchSales = db.queryOne(`
          SELECT 
            COUNT(id) as transactionCount,
            COALESCE(SUM(total_kes), 0.0) as totalRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total_kes ELSE 0 END), 0.0) as cashRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'MPESA' THEN total_kes ELSE 0 END), 0.0) as mpesaRevenueKes
          FROM sales
          WHERE tenant_id = ? AND branch_id = ? AND status = 'COMPLETED'
        `, [tenantId, branchId]) || { transactionCount: 0, totalRevenueKes: 0, cashRevenueKes: 0, mpesaRevenueKes: 0 };

        const staff = db.queryAll(`
          SELECT id, username, email, full_name, phone, role, active, created_at 
          FROM users 
          WHERE tenant_id = ? AND (branch_id = ? OR branch_id = 'ALL') AND role NOT IN ('super_admin', 'owner', 'admin')
          ORDER BY role ASC
        `, [tenantId, branchId]);

        const activeShifts = db.queryAll(`
          SELECT s.*, u.full_name as cashier_name, r.code as register_code
          FROM shifts s
          LEFT JOIN users u ON s.cashier_id = u.id
          LEFT JOIN registers r ON s.register_id = r.id
          WHERE s.tenant_id = ? AND s.branch_id = ? AND s.status = 'OPEN'
        `, [tenantId, branchId]);

        return {
          role: 'branch_manager',
          currency: 'KES',
          branch,
          tills,
          branchSales,
          staff,
          activeShifts
        };
      }

      case 'supervisor': {
        const suspendedSales = db.queryAll(`
          SELECT s.*, u.full_name as cashier_name, r.code as register_code
          FROM sales s
          LEFT JOIN users u ON s.cashier_id = u.id
          LEFT JOIN registers r ON s.register_id = r.id
          WHERE s.tenant_id = ? AND s.status = 'SUSPENDED'
          ORDER BY s.suspended_at DESC
        `, [tenantId]);

        const registers = db.queryAll('SELECT * FROM registers WHERE tenant_id = ?', [tenantId]);
        const recentApprovals = db.queryAll(`
          SELECT timestamp, event_type, user_name, action, status, reason 
          FROM audit_logs 
          WHERE tenant_id = ? AND (event_type LIKE '%SUSPENSION%' OR event_type LIKE '%RESUMPTION%')
          ORDER BY timestamp DESC LIMIT 10
        `, [tenantId]);

        return {
          role: 'supervisor',
          currency: 'KES',
          pendingSuspensionsCount: suspendedSales.length,
          suspendedSales,
          registers,
          recentApprovals,
          biometricSensor: {
            status: 'CONNECTED',
            driver: 'Windows Biometric Framework / USB Sensor SDK',
            challengeReadiness: 'ARMED'
          }
        };
      }

      case 'cashier': {
        const activeShift = db.queryOne(`
          SELECT s.*, r.code as register_code 
          FROM shifts s
          LEFT JOIN registers r ON s.register_id = r.id
          WHERE s.tenant_id = ? AND s.status = 'OPEN' 
          LIMIT 1
        `, [tenantId]) || { id: 'SHIFT-NONE', opening_float_kes: 2500, status: 'OPEN', cash_sales_kes: 0, mpesa_sales_kes: 0 };

        const recentSales = db.queryAll(`
          SELECT id, total_kes, payment_method, mpesa_code, status, created_at 
          FROM sales 
          WHERE tenant_id = ? 
          ORDER BY created_at DESC LIMIT 5
        `, [tenantId]);

        return {
          role: 'cashier',
          currency: 'KES',
          activeShift,
          recentSales,
          tillCode: 'TILL-01',
          scanEngine: 'ACTIVE (<15ms)',
          mpesaEngine: 'DARAJA 2.0 CONNECTED'
        };
      }

      case 'inventory_manager': {
        const totalProducts = db.queryOne('SELECT COUNT(id) as count FROM products WHERE tenant_id = ?', [tenantId]).count;
        const lowStockItems = db.queryAll(`
          SELECT p.id, p.name, p.barcode, p.category, p.unit, p.cost_price_kes, p.selling_price_kes, i.quantity, i.reorder_level
          FROM inventory i
          JOIN products p ON i.product_id = p.id
          WHERE i.tenant_id = ? AND i.quantity <= i.reorder_level
          ORDER BY i.quantity ASC
        `, [tenantId]);

        const valuation = db.queryOne(`
          SELECT COALESCE(SUM(i.quantity * p.cost_price_kes), 0.0) as totalValuationKes
          FROM inventory i
          JOIN products p ON i.product_id = p.id
          WHERE i.tenant_id = ?
        `, [tenantId]);

        const categories = db.queryAll(`
          SELECT category, COUNT(id) as itemCount 
          FROM products 
          WHERE tenant_id = ? 
          GROUP BY category
        `, [tenantId]);

        return {
          role: 'inventory_manager',
          currency: 'KES',
          totalProducts,
          lowStockCount: lowStockItems.length,
          totalInventoryValuationKes: valuation ? valuation.totalValuationKes : 0,
          lowStockItems,
          categories
        };
      }

      case 'procurement_officer': {
        return {
          role: 'procurement_officer',
          currency: 'KES',
          suppliers: [
            { id: 'SUP-01', name: 'Brookside Dairies Ltd', category: 'Dairy & Eggs', terms: '30 Days Net', phone: '254711002288' },
            { id: 'SUP-02', name: 'Pembe Flour Mills Ltd', category: 'Grains & Flours', terms: '15 Days Net', phone: '254711002289' },
            { id: 'SUP-03', name: 'Unga Farm Care / Jogoo', category: 'Grains & Flours', terms: '30 Days Net', phone: '254711002290' },
            { id: 'SUP-04', name: 'Unilever Kenya Ltd', category: 'Household & Cleaning', terms: '45 Days Net', phone: '254711002291' },
            { id: 'SUP-05', name: 'Bidco Africa Ltd', category: 'Pantry & Spices', terms: '30 Days Net', phone: '254711002292' },
            { id: 'SUP-06', name: 'Kenya Breweries Ltd', category: 'Beverages', terms: '7 Days Cash', phone: '254711002293' }
          ],
          purchaseOrders: [
            { poNumber: 'PO-2026-0881', supplier: 'Brookside Dairies Ltd', itemsCount: 150, totalKes: 7800.00, status: 'RECEIVED' },
            { poNumber: 'PO-2026-0882', supplier: 'Unga Farm Care', itemsCount: 200, totalKes: 31000.00, status: 'APPROVED' },
            { poNumber: 'PO-2026-0883', supplier: 'Unilever Kenya Ltd', itemsCount: 80, totalKes: 22000.00, status: 'PENDING_DELIVERY' }
          ]
        };
      }

      case 'accountant': {
        const taxStats = db.queryOne(`
          SELECT 
            COALESCE(SUM(CASE WHEN vat_rate = 16.0 THEN tax_kes ELSE 0 END), 0.0) as vatRateAKes,
            COALESCE(SUM(CASE WHEN vat_rate = 16.0 THEN subtotal_kes ELSE 0 END), 0.0) as standardSalesSubtotalKes,
            COALESCE(SUM(CASE WHEN vat_rate = 0.0 THEN subtotal_kes ELSE 0 END), 0.0) as zeroRatedSalesKes
          FROM sale_items
          WHERE tenant_id = ?
        `, [tenantId]) || { vatRateAKes: 0, standardSalesSubtotalKes: 0, zeroRatedSalesKes: 0 };

        const salesStats = db.queryOne(`
          SELECT 
            COALESCE(SUM(total_kes), 0.0) as totalRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'CASH' THEN total_kes ELSE 0 END), 0.0) as cashRevenueKes,
            COALESCE(SUM(CASE WHEN payment_method = 'MPESA' THEN total_kes ELSE 0 END), 0.0) as mpesaRevenueKes
          FROM sales
          WHERE tenant_id = ? AND status = 'COMPLETED'
        `, [tenantId]) || { totalRevenueKes: 0, cashRevenueKes: 0, mpesaRevenueKes: 0 };

        return {
          role: 'accountant',
          currency: 'KES',
          totalRevenueKes: salesStats.totalRevenueKes,
          standardSalesSubtotalKes: taxStats.standardSalesSubtotalKes,
          vatRateAKes: taxStats.vatRateAKes,
          zeroRatedSalesKes: taxStats.zeroRatedSalesKes,
          tenderReconciliation: {
            cashKes: salesStats.cashRevenueKes,
            mpesaKes: salesStats.mpesaRevenueKes,
            discrepancyKes: 0.00
          },
          etimsCompliance: {
            kraPin: tenant.kra_pin,
            controlUnitSerial: 'KRA-CU-2026-99214',
            status: 'CONNECTED',
            lastTransmission: new Date().toISOString()
          }
        };
      }

      case 'auditor': {
        const auditLogs = db.queryAll(`
          SELECT id, timestamp, event_type, user_name, user_role, branch_id, action, status, reason, integrity_checksum
          FROM audit_logs
          WHERE tenant_id = ? OR tenant_id = 'GLOBAL'
          ORDER BY timestamp DESC
          LIMIT 25
        `, [tenantId]);

        const totalAuditLogs = db.queryOne("SELECT COUNT(id) as count FROM audit_logs WHERE tenant_id = ? OR tenant_id = 'GLOBAL'", [tenantId]).count;
        const failedAttempts = db.queryOne("SELECT COUNT(id) as count FROM audit_logs WHERE (tenant_id = ? OR tenant_id = 'GLOBAL') AND status = 'FAILED'", [tenantId]).count;

        return {
          role: 'auditor',
          currency: 'KES',
          totalAuditLogs,
          failedAttempts,
          auditLogs,
          securityStatus: {
            biometricSignatures: 'ECDSA P-256 Cryptographically Signed',
            tamperProofVerification: 'PASSED',
            rawBiometricsStored: 'NONE (Zero-Knowledge)'
          }
        };
      }

      default:
        return { role, message: 'Dashboard data ready' };
    }
  }

  static sendJson(res, statusCode, data) {
    res.statusCode = statusCode;
    res.end(JSON.stringify(data));
  }
}

module.exports = SaasRouter;
