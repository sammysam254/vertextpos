const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

/**
 * Enterprise SQLite Datastore using Node.js v26 native DatabaseSync.
 * Zero external C++ or npm dependencies.
 * Provides microsecond in-process query execution and full multi-tenant isolation.
 */
class SqliteStore {
  constructor(dbPath) {
    const isServerless = !!(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT || process.env.VERCEL);
    const dataDir = isServerless ? '/tmp' : path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) {
      try {
        fs.mkdirSync(dataDir, { recursive: true });
      } catch (e) {}
    }
    this.dbPath = dbPath || (isServerless ? path.join('/tmp', 'saas_pos.db') : path.join(dataDir, 'saas_pos.db'));
    this.db = new DatabaseSync(this.dbPath);
    this.initPragmas();
    this.initTables();
  }

  initPragmas() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA synchronous = NORMAL;
    `);
  }

  initTables() {
    this.db.exec(`
      -- 1. SaaS Tenants
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        trade_name TEXT NOT NULL,
        kra_pin TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        currency TEXT DEFAULT 'KES',
        plan_id TEXT NOT NULL,
        status TEXT DEFAULT 'ACTIVE',
        trial_ends_at TEXT,
        subscription_expires_at TEXT,
        mpesa_shortcode TEXT,
        mpesa_passkey TEXT,
        mpesa_consumer_key TEXT,
        mpesa_consumer_secret TEXT,
        mpesa_type TEXT DEFAULT 'TILL',
        receipt_header_msg TEXT,
        receipt_footer_msg TEXT,
        monthly_subscription_kes REAL DEFAULT 6500.00,
        logo_base64 TEXT,
        location TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 2. SaaS Plans
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price_kes REAL NOT NULL,
        billing_cycle TEXT NOT NULL,
        max_branches INTEGER NOT NULL,
        max_registers INTEGER NOT NULL,
        max_skus INTEGER NOT NULL,
        features_json TEXT
      );

      -- 3. Supermarket Branches
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        location TEXT NOT NULL,
        phone TEXT,
        status TEXT DEFAULT 'ACTIVE',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      -- 4. Registers (POS Tills)
      CREATE TABLE IF NOT EXISTS registers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        code TEXT NOT NULL,
        name TEXT NOT NULL,
        printer_type TEXT DEFAULT 'ESC_POS_80MM',
        status TEXT DEFAULT 'ONLINE',
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE
      );

      -- 5. Users & RBAC (10 Roles)
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        username TEXT NOT NULL,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        full_name TEXT NOT NULL,
        phone TEXT,
        role TEXT NOT NULL,
        branch_id TEXT DEFAULT 'ALL',
        permissions_json TEXT,
        pin_code TEXT,
        active INTEGER DEFAULT 1,
        locked_until TEXT,
        failed_attempts INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 6. Products Catalog
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        barcode TEXT NOT NULL,
        sku TEXT NOT NULL,
        category TEXT NOT NULL,
        unit TEXT DEFAULT 'PCS',
        cost_price_kes REAL NOT NULL,
        selling_price_kes REAL NOT NULL,
        wholesale_price_kes REAL,
        vat_rate REAL DEFAULT 16.0,
        min_stock INTEGER DEFAULT 5,
        is_weighed INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      -- 7. Branch Inventory
      CREATE TABLE IF NOT EXISTS inventory (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        quantity REAL DEFAULT 0.000,
        reorder_level INTEGER DEFAULT 10,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
        FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        UNIQUE (tenant_id, branch_id, product_id)
      );

      -- 8. Stock Movement Ledger
      CREATE TABLE IF NOT EXISTS stock_movements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        movement_type TEXT NOT NULL,
        quantity REAL NOT NULL,
        balance_after REAL NOT NULL,
        reference_id TEXT,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 9. Cashier Shifts
      CREATE TABLE IF NOT EXISTS shifts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        cashier_id TEXT NOT NULL,
        status TEXT DEFAULT 'OPEN',
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        opening_float_kes REAL NOT NULL,
        closing_cash_kes REAL,
        expected_cash_kes REAL,
        variance_kes REAL,
        cash_sales_kes REAL DEFAULT 0.00,
        mpesa_sales_kes REAL DEFAULT 0.00,
        card_sales_kes REAL DEFAULT 0.00,
        notes TEXT,
        approved_by TEXT
      );

      -- 10. Customers & Loyalty
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        loyalty_points INTEGER DEFAULT 0,
        credit_limit_kes REAL DEFAULT 0.00,
        current_balance_kes REAL DEFAULT 0.00,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      );

      -- 11. Sales & Transactions
      CREATE TABLE IF NOT EXISTS sales (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        register_id TEXT NOT NULL,
        cashier_id TEXT NOT NULL,
        customer_id TEXT,
        shift_id TEXT,
        status TEXT NOT NULL,
        subtotal_kes REAL NOT NULL,
        tax_kes REAL NOT NULL,
        total_kes REAL NOT NULL,
        paid_amount_kes REAL DEFAULT 0.00,
        balance_due_kes REAL NOT NULL,
        payment_method TEXT,
        mpesa_code TEXT,
        kra_etims_cu TEXT,
        kra_etims_qr TEXT,
        suspended_at TEXT,
        suspended_by TEXT,
        suspension_reason TEXT,
        resumed_at TEXT,
        resumed_by TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 12. Sale Items
      CREATE TABLE IF NOT EXISTS sale_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        sale_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        product_name TEXT NOT NULL,
        barcode TEXT NOT NULL,
        quantity REAL NOT NULL,
        unit_price_kes REAL NOT NULL,
        discount_kes REAL DEFAULT 0.00,
        subtotal_kes REAL NOT NULL,
        tax_kes REAL NOT NULL,
        vat_rate REAL DEFAULT 16.0,
        FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE
      );

      -- 13. Payments Ledger
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        sale_id TEXT NOT NULL,
        method TEXT NOT NULL,
        amount_kes REAL NOT NULL,
        status TEXT NOT NULL,
        reference TEXT,
        mpesa_request_id TEXT,
        mpesa_receipt_code TEXT,
        customer_phone TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      );

      -- 14. M-Pesa Daraja Transactions
      CREATE TABLE IF NOT EXISTS mpesa_transactions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        merchant_request_id TEXT NOT NULL,
        checkout_request_id TEXT UNIQUE NOT NULL,
        sale_id TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        amount_kes REAL NOT NULL,
        status TEXT DEFAULT 'PENDING',
        mpesa_receipt TEXT,
        result_code INTEGER,
        result_desc TEXT,
        callback_payload TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        completed_at TEXT
      );

      -- 15. Audit Logs
      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        user_name TEXT NOT NULL,
        user_role TEXT NOT NULL,
        branch_id TEXT,
        register_id TEXT,
        action TEXT NOT NULL,
        status TEXT NOT NULL,
        device_id TEXT,
        reason TEXT,
        metadata_json TEXT,
        integrity_checksum TEXT NOT NULL
      );

      -- 16. Offline Sync Outbox Queue (for Cloud Real-Time Supabase Sync)
      CREATE TABLE IF NOT EXISTS offline_sync_queue (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        synced_at TEXT
      );

      -- Create High-Performance Indexes
      CREATE INDEX IF NOT EXISTS idx_products_tenant_barcode ON products(tenant_id, barcode);
      CREATE INDEX IF NOT EXISTS idx_inventory_tenant_branch ON inventory(tenant_id, branch_id);
      CREATE INDEX IF NOT EXISTS idx_sales_tenant_status ON sales(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_shifts_tenant_status ON shifts(tenant_id, status);
      CREATE INDEX IF NOT EXISTS idx_mpesa_checkout ON mpesa_transactions(checkout_request_id);
      CREATE INDEX IF NOT EXISTS idx_audit_tenant_event ON audit_logs(tenant_id, event_type);
      CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON offline_sync_queue(status);
    `);

    // Column migrations for existing databases
    try {
      const cols = this.db.prepare('PRAGMA table_info(tenants)').all().map(c => c.name);
      if (!cols.includes('mpesa_shortcode')) this.db.exec('ALTER TABLE tenants ADD COLUMN mpesa_shortcode TEXT');
      if (!cols.includes('mpesa_passkey')) this.db.exec('ALTER TABLE tenants ADD COLUMN mpesa_passkey TEXT');
      if (!cols.includes('mpesa_consumer_key')) this.db.exec('ALTER TABLE tenants ADD COLUMN mpesa_consumer_key TEXT');
      if (!cols.includes('mpesa_consumer_secret')) this.db.exec('ALTER TABLE tenants ADD COLUMN mpesa_consumer_secret TEXT');
      if (!cols.includes('mpesa_type')) this.db.exec("ALTER TABLE tenants ADD COLUMN mpesa_type TEXT DEFAULT 'TILL'");
      if (!cols.includes('receipt_header_msg')) this.db.exec('ALTER TABLE tenants ADD COLUMN receipt_header_msg TEXT');
      if (!cols.includes('receipt_footer_msg')) this.db.exec('ALTER TABLE tenants ADD COLUMN receipt_footer_msg TEXT');
      if (!cols.includes('monthly_subscription_kes')) this.db.exec('ALTER TABLE tenants ADD COLUMN monthly_subscription_kes REAL DEFAULT 6500.00');
      if (!cols.includes('logo_base64')) this.db.exec('ALTER TABLE tenants ADD COLUMN logo_base64 TEXT');
      if (!cols.includes('location')) this.db.exec('ALTER TABLE tenants ADD COLUMN location TEXT');
    } catch (e) {
      // Ignore if columns exist
    }
  }

  // Generic query execution helpers
  exec(sql) {
    return this.db.exec(sql);
  }

  prepare(sql) {
    return this.db.prepare(sql);
  }

  queryAll(sql, params = []) {
    const safeParams = params.map(p => p === undefined ? null : p);
    const stmt = this.db.prepare(sql);
    return stmt.all(...safeParams);
  }

  queryOne(sql, params = []) {
    const safeParams = params.map(p => p === undefined ? null : p);
    const stmt = this.db.prepare(sql);
    return stmt.get(...safeParams);
  }

  run(sql, params = []) {
    const safeParams = params.map(p => p === undefined ? null : p);
    const stmt = this.db.prepare(sql);
    return stmt.run(...safeParams);
  }

  // Scoped Transaction block
  transaction(fn) {
    this.db.exec('BEGIN TRANSACTION');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close() {
    this.db.close();
  }
}

// Singleton Datastore instance
const db = new SqliteStore();
module.exports = db;

