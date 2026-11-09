# System Architecture: Supermarket POS & Retail Management SaaS

## 1. High-Level Architecture Diagram

```mermaid
flowchart TD
    subgraph Clients["Frontend Clients & Hardware"]
        POS["Cashier POS Terminal\n(Touch & Keyboard Wedge)"]
        ADMIN_UI["Business Owner / Admin Portal"]
        SUPER_UI["SaaS Super Admin Console"]
        THERMAL["Thermal Printer\n(ESC/POS 58mm/80mm)"]
        SCANNER["Barcode Scanner\n(USB / Wireless / Camera)"]
    end

    subgraph API_Gateway["Node.js Application Server (Port 3000)"]
        ROUTER["HTTP / REST API Router"]
        AUTH_MW["Authentication & Tenant Isolation Middleware"]
        SSE_HUB["Server-Sent Events (SSE) Real-Time Hub"]
    end

    subgraph Core_Services["Core Application Subsystems"]
        AUTH_SVC["Auth & RBAC Service (10 Roles)"]
        TENANT_SVC["Tenant & Subscription Manager"]
        POS_SVC["POS Checkout & Cart Engine"]
        SHIFT_SVC["Shift & Cash Drawer Service"]
        INV_SVC["Inventory & Stock Ledger Service"]
        MPESA_SVC["Safaricom Daraja 2.0 Engine"]
        ETIMS_SVC["KRA eTIMS Tax Compliance Engine"]
        PRINT_SVC["ESC/POS Receipt Generator"]
        BIO_SVC["Biometric Supervisor HAL"]
    end

    subgraph Data_Layer["Persistent Storage & Audit"]
        SQLITE_DB[("ACID SQLite Enterprise Store\n(Tenant-Scoped Schemas)")]
        AUDIT_LOG[("Cryptographic Audit Ledger")]
    end

    subgraph External_Gateways["External Providers"]
        SAFARICOM["Safaricom Daraja API\n(STK Push / C2B Callbacks)"]
        KRA["Kenya Revenue Authority\neTIMS Validation Engine"]
    end

    POS -->|HTTP REST / SSE| ROUTER
    ADMIN_UI -->|HTTP REST| ROUTER
    SUPER_UI -->|HTTP REST| ROUTER
    SCANNER -.->|HID Keyboard Events| POS
    POS -->|Raw Print Commands| THERMAL

    ROUTER --> AUTH_MW
    AUTH_MW --> Core_Services
    SSE_HUB <--> Core_Services
    SSE_HUB -->|Real-Time Payment Notifications| POS

    MPESA_SVC <-->|HTTPS REST| SAFARICOM
    ETIMS_SVC <-->|Trader API Protocols| KRA

    Core_Services --> SQLITE_DB
    Core_Services --> AUDIT_LOG
```

---

## 2. Multi-Tenant SaaS Isolation Model

The platform uses a **Discriminator Column & Row-Level Authorization** multi-tenant model.
- Every tenant has a unique `tenant_id` (e.g. `tenant_naivas_01`, `tenant_quickmart_02`, `tenant_demo_01`).
- All persistent tables contain `tenant_id VARCHAR NOT NULL REFERENCES tenants(id)`.
- The `TenantContext` middleware extracts the tenant from the JWT bearer token, API key, or custom `X-Tenant-Id` header.
- Every query, update, or deletion is strictly guarded by `WHERE tenant_id = ?`.
- No cross-tenant data leak is physically possible.

### Subscription Tier Enforcement
| Plan | Price (KES/mo) | Max Branches | Max Tills / Registers | Max SKUs | Features Included |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Free Trial (14 Days)** | KES 0 | 1 | 1 | 250 | Basic POS, Cash Sales, Receipt Printing |
| **Starter Retail** | KES 2,500 | 1 | 2 | 2,000 | M-Pesa STK, Barcode Scanning, Basic Shifts |
| **Supermarket Growth**| KES 6,500 | 3 | 6 | 15,000 | Full Shifts, Multi-Branch, eTIMS Ready, Suspended Sales |
| **Enterprise Chain** | KES 15,000 | Unlimited | Unlimited | Unlimited | Biometric Control, Centralized Procurement, Dedicated API |

---

## 3. The Zero-Wait M-Pesa Checkout Flow

```mermaid
sequenceDiagram
    autonumber
    actor Customer
    actor Cashier
    participant POS as POS Client Terminal
    participant Backend as SaaS Backend Server
    participant Safaricom as Safaricom Daraja API
    participant Printer as ESC/POS Receipt Printer

    Cashier->>POS: Scans products (Sub-100ms cart updates)
    POS->>POS: Calculates KES Total & 16% VAT
    Cashier->>POS: Selects M-Pesa & inputs Customer Phone (e.g. 254712345678)
    POS->>Backend: POST /api/mpesa/stk-push (Amount, Phone, TxID)
    Backend->>Safaricom: Initiate STK Push (Express Request)
    Safaricom-->>Customer: USSD SIM Prompt ("Do you want to pay KES 1,450 to MetroMart?")
    
    note over Cashier,POS: Cashier clicks "SERVE NEXT CUSTOMER" or continues scanning. Cart is safely pending!
    
    Customer->>Safaricom: Enters M-Pesa Secret PIN
    Safaricom->>Backend: POST /api/mpesa/callback (Encrypted Webhook Callback)
    Backend->>Backend: Verify Callback Idempotency & Signatures
    Backend->>Backend: Match Invoice & Update Payment Status: "PAID"
    Backend->>Backend: Deduct Stock Movements in Inventory Ledger
    Backend->>POS: SSE Event: PAYMENT_CONFIRMED (TxCode: QA89DF8921, Amount: KES 1,450)
    POS->>POS: Audio Chime & Visual Green Badge: "PAID VIA M-PESA"
    POS->>Printer: Trigger Automatic Print (Raw ESC/POS Thermal Stream)
    Printer-->>Cashier: Thermal Receipt Cut & Ready
```

---

## 4. Hardware Integration Layer

### ESC/POS Printer Engine
- Generates compliant ESC/POS binary sequences:
  - `ESC @` (Initialize printer)
  - `ESC a 1` (Center alignment)
  - `GS ! 1` (Double height text for store banner)
  - `ESC E 1` (Bold text on/off)
  - `GS k` (Barcode Code128 generation)
  - `GS ( k` (QR Code Model 2 generation for KRA eTIMS URL)
  - `GS V 66 0` (Partial cut with feed)
- Renders dual formats: **58mm (32 characters per line)** and **80mm (48 characters per line)**.
- Provides browser visual canvas fallback and PDF export.

### Barcode & Scanner Compatibility
- Standard HID Keyboard-Wedge: Intercepts raw serial input ending with `Enter` (`\n`), matching barcodes under 20ms.
- Built-in camera scanner via modern WebRTC MediaDevices API.
- Support for Kenya national barcodes (EAN-13 prefix `616` and international prefixes).

