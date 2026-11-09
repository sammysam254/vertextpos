-- Supabase / PostgreSQL Enterprise Supermarket POS SaaS Schema
-- Multi-Tenant Architecture with Row-Level Security (RLS)
-- Currency: KES (Kenyan Shilling)

-- 1. Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Tenants Table
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    slug VARCHAR(64) UNIQUE NOT NULL,
    legal_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255) NOT NULL,
    kra_pin VARCHAR(32) NOT NULL,
    business_phone VARCHAR(32) NOT NULL,
    business_email VARCHAR(255) UNIQUE NOT NULL,
    currency VARCHAR(8) DEFAULT 'KES',
    plan_tier VARCHAR(32) DEFAULT 'growth',
    monthly_subscription_kes NUMERIC(12, 2) NOT NULL DEFAULT 6500.00,
    billing_day_of_month INT DEFAULT 1,
    subscription_status VARCHAR(32) DEFAULT 'ACTIVE',
    location VARCHAR(255) NOT NULL,
    mpesa_shortcode VARCHAR(64),
    mpesa_passkey TEXT,
    mpesa_consumer_key TEXT,
    mpesa_consumer_secret TEXT,
    mpesa_type VARCHAR(16) DEFAULT 'TILL',
    receipt_header_msg TEXT,
    receipt_footer_msg TEXT,
    logo_base64 TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Branches Table
CREATE TABLE IF NOT EXISTS branches (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    location VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    status VARCHAR(32) DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Registers (POS Tills)
CREATE TABLE IF NOT EXISTS registers (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    code VARCHAR(32) NOT NULL,
    name VARCHAR(128) NOT NULL,
    printer_type VARCHAR(32) DEFAULT 'ESC_POS_80MM',
    status VARCHAR(32) DEFAULT 'ONLINE',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Users Table (10 Roles)
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(64) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    password_salt VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    phone VARCHAR(32),
    role VARCHAR(32) NOT NULL,
    branch_id UUID REFERENCES branches(id) ON DELETE SET NULL,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    permissions JSONB DEFAULT '[]'::jsonb,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Products Table (Kenyan FMCG with Barcodes)
CREATE TABLE IF NOT EXISTS products (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    barcode VARCHAR(64) NOT NULL,
    sku VARCHAR(64) NOT NULL,
    category VARCHAR(128) NOT NULL,
    unit VARCHAR(32) DEFAULT 'PCS',
    cost_price_kes NUMERIC(12, 2) NOT NULL,
    selling_price_kes NUMERIC(12, 2) NOT NULL,
    wholesale_price_kes NUMERIC(12, 2),
    vat_rate NUMERIC(5, 2) DEFAULT 16.00,
    min_stock INT DEFAULT 5,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Inventory Table
CREATE TABLE IF NOT EXISTS inventory (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    quantity NUMERIC(12, 3) DEFAULT 0.000,
    reorder_level INT DEFAULT 10,
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(tenant_id, branch_id, product_id)
);

-- 8. Stock Movements Ledger
CREATE TABLE IF NOT EXISTS stock_movements (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    movement_type VARCHAR(32) NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL,
    balance_after NUMERIC(12, 3) NOT NULL,
    reference_id VARCHAR(128),
    notes TEXT,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Cashier Shifts Table
CREATE TABLE IF NOT EXISTS shifts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES registers(id) ON DELETE CASCADE,
    cashier_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(32) DEFAULT 'OPEN',
    opened_at TIMESTAMPTZ DEFAULT NOW(),
    closed_at TIMESTAMPTZ,
    opening_float_kes NUMERIC(12, 2) NOT NULL,
    closing_cash_kes NUMERIC(12, 2),
    expected_cash_kes NUMERIC(12, 2),
    variance_kes NUMERIC(12, 2),
    cash_sales_kes NUMERIC(12, 2) DEFAULT 0.00,
    mpesa_sales_kes NUMERIC(12, 2) DEFAULT 0.00,
    notes TEXT,
    approved_by UUID REFERENCES users(id)
);

-- 10. Sales Transactions Table
CREATE TABLE IF NOT EXISTS sales (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    register_id UUID NOT NULL REFERENCES registers(id) ON DELETE CASCADE,
    cashier_id UUID NOT NULL REFERENCES users(id),
    shift_id UUID REFERENCES shifts(id),
    status VARCHAR(32) NOT NULL,
    subtotal_kes NUMERIC(12, 2) NOT NULL,
    tax_kes NUMERIC(12, 2) NOT NULL,
    total_kes NUMERIC(12, 2) NOT NULL,
    paid_amount_kes NUMERIC(12, 2) DEFAULT 0.00,
    balance_due_kes NUMERIC(12, 2) NOT NULL,
    payment_method VARCHAR(32),
    mpesa_code VARCHAR(64),
    kra_etims_cu VARCHAR(64),
    kra_etims_qr TEXT,
    suspended_at TIMESTAMPTZ,
    suspended_by VARCHAR(255),
    suspension_reason TEXT,
    resumed_at TIMESTAMPTZ,
    resumed_by VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Sale Items Table
CREATE TABLE IF NOT EXISTS sale_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id UUID NOT NULL REFERENCES products(id),
    product_name VARCHAR(255) NOT NULL,
    barcode VARCHAR(64) NOT NULL,
    quantity NUMERIC(12, 3) NOT NULL,
    unit_price_kes NUMERIC(12, 2) NOT NULL,
    discount_kes NUMERIC(12, 2) DEFAULT 0.00,
    subtotal_kes NUMERIC(12, 2) NOT NULL,
    tax_kes NUMERIC(12, 2) NOT NULL,
    vat_rate NUMERIC(5, 2) DEFAULT 16.00
);

-- 12. M-Pesa Daraja Transactions Table
CREATE TABLE IF NOT EXISTS mpesa_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    merchant_request_id VARCHAR(128) NOT NULL,
    checkout_request_id VARCHAR(128) UNIQUE NOT NULL,
    sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    customer_phone VARCHAR(32) NOT NULL,
    amount_kes NUMERIC(12, 2) NOT NULL,
    status VARCHAR(32) DEFAULT 'PENDING',
    mpesa_receipt VARCHAR(64),
    result_code INT,
    result_desc TEXT,
    callback_payload JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

-- 13. Audit Logs Table
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    timestamp TIMESTAMPTZ DEFAULT NOW(),
    event_type VARCHAR(64) NOT NULL,
    user_id VARCHAR(64) NOT NULL,
    user_name VARCHAR(255) NOT NULL,
    user_role VARCHAR(64) NOT NULL,
    branch_id VARCHAR(64),
    register_id VARCHAR(64),
    action VARCHAR(128) NOT NULL,
    status VARCHAR(32) NOT NULL,
    device_id VARCHAR(64),
    reason TEXT,
    metadata_json JSONB,
    integrity_checksum VARCHAR(128) NOT NULL
);

-- Row Level Security (RLS) Example Policies
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_products ON products
    FOR ALL
    USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- =========================================================================
-- 14. SEED SAAS SUPER ADMIN (Online Cloud First)
-- Email: sammyseth260@gmail.com
-- Role: super_admin (Elevated privileges to create Business Owners)
-- =========================================================================
INSERT INTO users (id, tenant_id, username, email, password_hash, password_salt, full_name, phone, role, branch_id, permissions, is_active)
VALUES (
    uuid_generate_v4(),
    NULL,
    'sammyseth',
    'sammyseth260@gmail.com',
    '33a39e877fc89dd7dffba766c6baecf109b0b4ae8a032fcfc526a0f6a2083db18e55e0a0ba6db3c7b275bf46ae72e2cfc053c84aa8e05f63d7634f40f04f0d7e',
    '2a2656d0d210ae67',
    'Sammy Seth (SaaS Super Admin)',
    '+254700000000',
    'super_admin',
    NULL,
    '["ALL_SAAS_CONTROL", "MANAGE_TENANTS", "CONFIGURE_DARAJA", "VIEW_FINANCIALS"]'::jsonb,
    TRUE
) ON CONFLICT (email) DO NOTHING;


