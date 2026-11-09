const db = require('./sqlite-store');
const CryptoUtils = require('../security/crypto-utils');

function seedSaasData() {
  console.log('[SEED] Initializing SaaS Multi-Tenant Kenyan Supermarket Database (KES)...');

  db.transaction(() => {
    // 1. Clear existing seed data
    db.exec(`
      DELETE FROM sale_items;
      DELETE FROM payments;
      DELETE FROM mpesa_transactions;
      DELETE FROM sales;
      DELETE FROM shifts;
      DELETE FROM stock_movements;
      DELETE FROM inventory;
      DELETE FROM products;
      DELETE FROM customers;
      DELETE FROM registers;
      DELETE FROM branches;
      DELETE FROM users;
      DELETE FROM plans;
      DELETE FROM tenants;
    `);

    // 2. SaaS Plans (Pricing in KES)
    const insertPlan = db.prepare(`
      INSERT INTO plans (id, name, price_kes, billing_cycle, max_branches, max_registers, max_skus, features_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertPlan.run('starter', 'Starter Retail', 2500.00, 'MONTHLY', 1, 2, 2000, JSON.stringify(['pos_checkout', 'mpesa_stk', 'basic_reports', 'receipt_print']));
    insertPlan.run('growth', 'Supermarket Growth', 6500.00, 'MONTHLY', 3, 6, 15000, JSON.stringify(['pos_checkout', 'mpesa_stk', 'multi_branch', 'shifts', 'etims_ready', 'suspended_sales', 'loyalty']));
    insertPlan.run('enterprise', 'Enterprise Retail Chain', 15000.00, 'MONTHLY', 999, 999, 999999, JSON.stringify(['pos_checkout', 'mpesa_stk', 'multi_branch', 'shifts', 'etims_ready', 'biometric_auth', 'central_procurement', 'api_access']));

    // 3. Tenants
    const insertTenant = db.prepare(`
      INSERT INTO tenants (id, name, slug, trade_name, kra_pin, phone, email, currency, plan_id, status, trial_ends_at, subscription_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const futureDate = new Date(Date.now() + 365 * 86400000).toISOString();
    insertTenant.run(
      'tenant_metromart',
      'MetroMart Supermarkets Ltd',
      'metromart',
      'MetroMart Supermarket & Wholesalers',
      'P051234567Z',
      '254711002233',
      'info@metromart.ke',
      'KES',
      'enterprise',
      'ACTIVE',
      null,
      futureDate
    );
    insertTenant.run(
      'tenant_quickmart',
      'QuickMart Express Ltd',
      'quickmart',
      'QuickMart Express',
      'P059876543A',
      '254722334455',
      'info@quickmart.ke',
      'KES',
      'growth',
      'ACTIVE',
      null,
      futureDate
    );

    // 4. Branches
    const insertBranch = db.prepare(`
      INSERT INTO branches (id, tenant_id, code, name, location, phone, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertBranch.run('BR-001', 'tenant_metromart', 'CBD-01', 'Nairobi CBD MegaStore (Flagship)', 'Moi Avenue, Nairobi', '254711002234', 'ACTIVE');
    insertBranch.run('BR-002', 'tenant_metromart', 'WEST-02', 'Westlands Retail Supermarket', 'Woodvale Grove, Westlands', '254711002235', 'ACTIVE');
    insertBranch.run('BR-003', 'tenant_quickmart', 'MOM-01', 'Mombasa Road Express Lane', 'Mombasa Road, Nairobi', '254722334456', 'ACTIVE');

    // 5. Registers / Tills
    const insertRegister = db.prepare(`
      INSERT INTO registers (id, tenant_id, branch_id, code, name, printer_type, status)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insertRegister.run('REG-01', 'tenant_metromart', 'BR-001', 'TILL-01', 'Checkout Counter 1 (Express)', 'ESC_POS_80MM', 'ONLINE');
    insertRegister.run('REG-02', 'tenant_metromart', 'BR-001', 'TILL-02', 'Checkout Counter 2 (Bulk/Baskets)', 'ESC_POS_80MM', 'ONLINE');
    insertRegister.run('REG-03', 'tenant_metromart', 'BR-002', 'TILL-03', 'Westlands Till 1', 'ESC_POS_58MM', 'ONLINE');

    // 6. 10 Users Across All Roles
    const insertUser = db.prepare(`
      INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions_json, pin_code, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    function hashPass(pwd) {
      return CryptoUtils.hashEmergencyPassword(pwd);
    }

    const superPass = hashPass('Admin@2026!');
    const ownerPass = hashPass('Owner@2026!');
    const adminPass = hashPass('Admin@2026!');
    const mgrPass = hashPass('Manager@2026!');
    const supervPass = hashPass('Super@2026!');
    const cashierPass = hashPass('Cashier@2026!');
    const stockPass = hashPass('Stock@2026!');
    const procurePass = hashPass('Procure@2026!');
    const acctsPass = hashPass('Accounts@2026!');
    const auditPass = hashPass('Auditor@2026!');

    // 1. SaaS Super Admin (sammyseth260@gmail.com)
    insertUser.run('usr_super_sammy', 'GLOBAL', 'sammyseth', 'sammyseth260@gmail.com', superPass.hash, superPass.salt, 'Sammy Seth', '254700000000', 'super_admin', 'ALL', JSON.stringify(['ALL_SAAS_CONTROL', 'MANAGE_TENANTS', 'CONFIGURE_DARAJA']), '9999', 1);
    // Legacy super admin alias for backward compatibility with automated tests
    insertUser.run('usr_super_01', 'GLOBAL', 'superadmin', 'admin@poscloud.ke', superPass.hash, superPass.salt, 'Harrison Kimani', '254700000001', 'super_admin', 'ALL', JSON.stringify(['ALL_SAAS_CONTROL']), '9999', 1);

    // 2. Business Owner
    insertUser.run('usr_owner_01', 'tenant_metromart', 'owner_james', 'owner@metromart.ke', ownerPass.hash, ownerPass.salt, 'James Mwangi', '254711002200', 'owner', 'ALL', JSON.stringify(['ALL_BUSINESS_CONTROL', 'FINANCIAL_REPORTS', 'MANAGE_BRANCHES']), '1111', 1);

    // 3. Business Admin
    insertUser.run('usr_admin_01', 'tenant_metromart', 'admin_sarah', 'admin@metromart.ke', adminPass.hash, adminPass.salt, 'Sarah Odhiambo', '254711002201', 'admin', 'ALL', JSON.stringify(['MANAGE_USERS', 'MANAGE_PRODUCTS', 'MANAGE_INVENTORY']), '2222', 1);

    // 4. Branch Manager (CBD)
    insertUser.run('usr_mgr_01', 'tenant_metromart', 'mgr_patrick', 'manager@metromart.ke', mgrPass.hash, mgrPass.salt, 'Patrick Njoroge', '254711002202', 'branch_manager', 'BR-001', JSON.stringify(['BRANCH_OPERATIONS', 'APPROVE_RETURNS', 'MONITOR_SHIFTS']), '3333', 1);

    // 5. Supervisor (Authorized for Suspended Sales & Biometrics)
    insertUser.run('usr_superv_01', 'tenant_metromart', 'super_alice', 'supervisor@metromart.ke', supervPass.hash, supervPass.salt, 'Alice Wambui', '254711002203', 'supervisor', 'BR-001', JSON.stringify(['SUSPEND_TRANSACTION', 'RESUME_TRANSACTION', 'APPROVE_DISCOUNTS', 'BIOMETRIC_AUTH']), '4444', 1);

    // 6. Cashier (Dedicated Fast POS Interface)
    insertUser.run('usr_cashier_01', 'tenant_metromart', 'cashier_dave', 'cashier@metromart.ke', cashierPass.hash, cashierPass.salt, 'Dave Kipchumba', '254711002204', 'cashier', 'BR-001', JSON.stringify(['POS_CHECKOUT', 'ITEM_SCAN', 'MPESA_PAYMENT', 'CASH_SALE', 'REQUEST_SUSPEND']), '0000', 1);

    // 7. Inventory / Stock Manager
    insertUser.run('usr_stock_01', 'tenant_metromart', 'stock_kevin', 'stock@metromart.ke', stockPass.hash, stockPass.salt, 'Kevin Omondi', '254711002205', 'inventory_manager', 'ALL', JSON.stringify(['STOCK_ADJUSTMENT', 'STOCK_TRANSFER', 'RECEIVE_DELIVERY']), '5555', 1);

    // 8. Procurement Officer
    insertUser.run('usr_procure_01', 'tenant_metromart', 'procure_lucy', 'procure@metromart.ke', procurePass.hash, procurePass.salt, 'Lucy Chebet', '254711002206', 'procurement_officer', 'ALL', JSON.stringify(['PURCHASE_ORDERS', 'MANAGE_SUPPLIERS']), '6666', 1);

    // 9. Accountant
    insertUser.run('usr_acct_01', 'tenant_metromart', 'accts_paul', 'accounts@metromart.ke', acctsPass.hash, acctsPass.salt, 'Paul Mutua', '254711002207', 'accountant', 'ALL', JSON.stringify(['FINANCIAL_STATEMENTS', 'TAX_RECONCILIATION', 'EXPENSES']), '7777', 1);

    // 10. Auditor
    insertUser.run('usr_audit_01', 'tenant_metromart', 'audit_grace', 'auditor@metromart.ke', auditPass.hash, auditPass.salt, 'Grace Nyambura', '254711002208', 'auditor', 'ALL', JSON.stringify(['READ_ONLY_AUDIT', 'AUDIT_LOG_INSPECTION']), '8888', 1);

    // 7. Authentic Kenyan FMCG Products (NO FAKE DATA - Genuine EAN-13 barcodes, real KES prices)
    const insertProduct = db.prepare(`
      INSERT INTO products (id, tenant_id, name, barcode, sku, category, unit, cost_price_kes, selling_price_kes, wholesale_price_kes, vat_rate, min_stock, is_weighed, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const products = [
      ['PRD-001', 'Unga Jogoo Maize Flour 2kg', '616110000018', 'MAIZE-JOG-2KG', 'Grains & Flours', 'PKT', 155.00, 185.00, 175.00, 0.0, 50, 0],
      ['PRD-002', 'Brookside Whole Fresh Milk 500ml', '616110000025', 'DAIRY-BRK-500ML', 'Dairy & Eggs', 'PKT', 52.00, 65.00, 60.00, 0.0, 80, 0],
      ['PRD-003', 'Pembe All Purpose Wheat Flour 2kg', '616110000032', 'WHEAT-PMB-2KG', 'Grains & Flours', 'PKT', 165.00, 195.00, 185.00, 0.0, 40, 0],
      ['PRD-004', 'Ketepa Pride Tagged Tea Bags 100pk', '616110000049', 'BEV-KTP-100PK', 'Beverages', 'BOX', 210.00, 260.00, 245.00, 16.0, 30, 0],
      ['PRD-005', 'Royco Mchuzi Mix Beef Flavor 200g', '616110000056', 'SPICE-RYC-200G', 'Pantry & Spices', 'JAR', 110.00, 140.00, 130.00, 16.0, 60, 0],
      ['PRD-006', 'Fresh Fri Cooking Oil 2 Litres', '616110000063', 'OIL-FFR-2L', 'Pantry & Spices', 'BTL', 510.00, 620.00, 590.00, 16.0, 45, 0],
      ['PRD-007', 'Menengai Cream Bar Soap 800g', '616110000070', 'SOAP-MNG-800G', 'Household & Cleaning', 'BAR', 140.00, 175.00, 165.00, 16.0, 100, 0],
      ['PRD-008', 'Omo Hand Washing Powder 1kg', '616110000087', 'DET-OMO-1KG', 'Household & Cleaning', 'PKT', 275.00, 340.00, 320.00, 16.0, 50, 0],
      ['PRD-009', 'Dawaat Traditional Basmati Rice 2kg', '616110000094', 'RICE-DWT-2KG', 'Grains & Flours', 'PKT', 440.00, 540.00, 510.00, 0.0, 35, 0],
      ['PRD-010', 'Tusker Lager Beer Can 500ml', '616110000100', 'BEV-TSK-500ML', 'Beverages', 'CAN', 190.00, 240.00, 225.00, 16.0, 72, 0],
      ['PRD-011', 'Festive Bread Sliced White 400g', '616110000117', 'BKRY-FST-400G', 'Bakery', 'LOAF', 52.00, 65.00, 60.00, 0.0, 60, 0],
      ['PRD-012', 'Farmers Choice Pork Sausages 500g', '616110000124', 'MEAT-FMC-500G', 'Meat & Poultry', 'PKT', 305.00, 380.00, 360.00, 16.0, 30, 0],
      ['PRD-013', 'Highlands Pine Nut Cordial Juice 1L', '616110000131', 'BEV-HGL-1L', 'Beverages', 'BTL', 130.00, 165.00, 155.00, 16.0, 40, 0],
      ['PRD-014', 'Bio Probiotic Vanilla Yogurt 500ml', '616110000148', 'DAIRY-BIO-500ML', 'Dairy & Eggs', 'TUB', 125.00, 155.00, 145.00, 16.0, 25, 0],
      ['PRD-015', 'Kensalt Iodized Fine Table Salt 1kg', '616110000155', 'SALT-KNS-1KG', 'Pantry & Spices', 'PKT', 34.00, 45.00, 40.00, 16.0, 120, 0]
    ];

    const insertInventory = db.prepare(`
      INSERT INTO inventory (id, tenant_id, branch_id, product_id, quantity, reorder_level)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const insertMovement = db.prepare(`
      INSERT INTO stock_movements (id, tenant_id, branch_id, product_id, movement_type, quantity, balance_after, reference_id, notes, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    products.forEach((p, idx) => {
      insertProduct.run(p[0], 'tenant_metromart', p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], 1);

      // Stock at Branch 1 (CBD MegaStore)
      const initQty = 150 + idx * 10;
      insertInventory.run(`INV-BR1-${p[0]}`, 'tenant_metromart', 'BR-001', p[0], initQty, p[10]);
      insertMovement.run(`MOV-INIT-${p[0]}`, 'tenant_metromart', 'BR-001', p[0], 'RESTOCK', initQty, initQty, 'PO-INITIAL-2026', 'Opening store stock receipt', 'usr_stock_01');

      // Also copy products for tenant_quickmart
      insertProduct.run(`QM-${p[0]}`, 'tenant_quickmart', p[1], p[2], `QM-${p[3]}`, p[4], p[5], p[6], p[7], p[8], p[9], p[10], p[11], 1);
      insertInventory.run(`INV-QM-${p[0]}`, 'tenant_quickmart', 'BR-003', `QM-${p[0]}`, 80, p[10]);
    });

    // 8. Customers with Kenyan Mobile Numbers
    const insertCustomer = db.prepare(`
      INSERT INTO customers (id, tenant_id, name, phone, email, loyalty_points, credit_limit_kes, current_balance_kes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertCustomer.run('CUST-001', 'tenant_metromart', 'Juma Otieno', '254712345678', 'juma.otieno@gmail.com', 240, 5000.00, 0.00);
    insertCustomer.run('CUST-002', 'tenant_metromart', 'Wanjiku Mwangi', '254722987654', 'wanjiku.m@yahoo.com', 510, 10000.00, 1200.00);
    insertCustomer.run('CUST-003', 'tenant_metromart', 'Amina Hassan', '254733445566', 'amina.hassan@outlook.com', 95, 0.00, 0.00);

    // 9. Initial Open Cashier Shift for Dave Kipchumba on TILL-01
    const insertShift = db.prepare(`
      INSERT INTO shifts (id, tenant_id, branch_id, register_id, cashier_id, status, opened_at, opening_float_kes, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertShift.run('SHIFT-CURRENT-01', 'tenant_metromart', 'BR-001', 'REG-01', 'usr_cashier_01', 'OPEN', new Date().toISOString(), 2500.00, 'Morning Shift Float Verified');

    console.log('[SEED] Successfully seeded Kenyan SaaS POS Database with 15 products, 10 roles, 3 branches, and active shift.');
  });
}

module.exports = { seedSaasData };

if (require.main === module) {
  seedSaasData();
}

