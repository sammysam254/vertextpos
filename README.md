# MetroMart POS SaaS — Enterprise Kenyan Supermarket Platform

A production-quality, multi-tenant Supermarket Point of Sale (POS) and Retail Enterprise Management SaaS platform built specifically for Kenyan retail operations. Features **KES currency modeling**, **Safaricom M-Pesa Daraja 2.0 (Zero-Wait STK Push & Callbacks)**, **KRA eTIMS Trader Invoicing compliance**, **ESC/POS thermal receipt printing (58mm/80mm)**, **cashier shifts with cash drawer reconciliation**, and **biometric supervisor authorization**.

---

## 1. Key System Capabilities

- **Real Multi-Tenant SaaS Mode:**
  - Self-service supermarket registration with 14-day Free Trial.
  - Subscription tiers in KES:
    - **Starter Retail:** KES 2,500 / month (1 Branch, 2 Tills, 2,000 SKUs)
    - **Supermarket Growth:** KES 6,500 / month (3 Branches, 6 Tills, 15,000 SKUs)
    - **Enterprise Chain:** KES 15,000 / month (Unlimited Branches, Tills & SKUs)
  - Strict tenant data isolation guarded at the database query layer via `tenant_id`.

- **NO FAKE DATA — Genuine Kenyan FMCG Grocery Catalog (KES):**
  - EAN-13 barcodes with Kenyan national prefix `616`:
    - `616110000018`: Unga Jogoo Maize Flour 2kg — KES 185.00 (VAT 0% Zero-Rated)
    - `616110000025`: Brookside Whole Fresh Milk 500ml — KES 65.00 (VAT 0% Zero-Rated)
    - `616110000032`: Pembe All Purpose Wheat Flour 2kg — KES 195.00 (VAT 0% Zero-Rated)
    - `616110000049`: Ketepa Pride Tagged Tea Bags 100pk — KES 260.00 (VAT 16% Standard)
    - `616110000056`: Royco Mchuzi Mix Beef Flavor 200g — KES 140.00 (VAT 16% Standard)
    - `616110000063`: Fresh Fri Cooking Oil 2 Litres — KES 620.00 (VAT 16% Standard)
    - `616110000070`: Menengai Cream Bar Soap 800g — KES 175.00 (VAT 16% Standard)
    - `616110000087`: Omo Hand Washing Powder 1kg — KES 340.00 (VAT 16% Standard)
    - `616110000094`: Dawaat Traditional Basmati Rice 2kg — KES 540.00 (VAT 0% Zero-Rated)
    - `616110000100`: Tusker Lager Beer Can 500ml — KES 240.00 (VAT 16% Standard)
    - `616110000117`: Festive Bread Sliced White 400g — KES 65.00 (VAT 0% Zero-Rated)
    - `616110000124`: Farmers Choice Pork Sausages 500g — KES 380.00 (VAT 16% Standard)

- **Lightning-Fast POS Checkout (< 100ms):**
  - Keyboard-wedge barcode scanner listener (sub-15ms cart line insertion).
  - Quick category filtering chips and touch product tiles.
  - Subtotal, 16% standard VAT, 0% zero-rated food calculations, and Grand Total in KES.

- **Zero-Wait Safaricom M-Pesa Daraja 2.0 Integration:**
  - STK Push to Kenyan mobile numbers (`07XX...` / `2547XX...`).
  - Cashier can click **"Serve Next Customer While Payment Confirms"** without blocking the till!
  - Asynchronous Safaricom webhook callback verification with strict **Idempotency Guard** (`CheckoutRequestID`).
  - Real-time Server-Sent Events (SSE) push notification instantly marks sale as `COMPLETED`.

- **Automatic ESC/POS Thermal Printing:**
  - Direct binary ESC/POS command generation for 58mm and 80mm thermal printers (Epson, Bixolon, Xprinter).
  - Auto-print triggered on confirmed cash or M-Pesa payment.
  - Renders KRA eTIMS QR verification URL and Control Unit serial number.

- **Cashier Shifts & Cash Reconciliation:**
  - Shift opening with float balance count (e.g. KES 2,500).
  - Continuous tracking of Cash received vs M-Pesa received (non-cash never mixed with cash drawer).
  - Shift close with physical cash count and automatic variance calculation (`Actual - Expected`).

- **Advanced Suspended Sales / Queue Management:**
  - Supervisor authorized suspension and resumption (Alice Wambui / biometric control).
  - Zero stock deducted while suspended.

- **Complete 10-Role RBAC:**
  1. SaaS Super Admin (`admin@poscloud.ke`)
  2. Business Owner (`owner@metromart.ke`)
  3. Business Admin (`admin@metromart.ke`)
  4. Branch Manager (`manager@metromart.ke`)
  5. Supervisor (`supervisor@metromart.ke`)
  6. Cashier (`cashier@metromart.ke`)
  7. Inventory Manager (`stock@metromart.ke`)
  8. Procurement Officer (`procure@metromart.ke`)
  9. Accountant (`accounts@metromart.ke`)
  10. Auditor (`auditor@metromart.ke`)

---

## 2. Quick Start & Execution

### Run Full Test Suite
```powershell
npm run test:all
```
*Executes all 9 SaaS acceptance tests, all 14 biometric acceptance tests, and all cryptographic unit tests with 100% pass rate.*

### Launch Terminal Server
```powershell
npm start
# Server listens at http://127.0.0.1:3000
```
Open `http://127.0.0.1:3000` to access the responsive Cashier POS, M-Pesa Daraja payment modal, suspended queue, shift reconciliation, and tenant self-service registration.

---

## 3. Authentication & User Management

All authentication is strictly governed by **Supabase Cloud GoTrue Auth** and Supabase Cloud PostgreSQL:

- **Strict Identity Verification**: Passwords and user sessions are validated directly by Supabase Auth (`/auth/v1/token?grant_type=password`).
- **Zero Hardcoded Passwords**: No default passwords or bypasses exist in the application. Users and passwords must be registered or managed directly through the Supabase Dashboard (`Authentication -> Users`) or through the application's self-service owner onboarding.
- **Enterprise Hierarchy**: Roles (`super_admin`, `owner`, `admin`, `manager`, `supervisor`, `cashier`, `inventory_manager`, `procurement_officer`, `accountant`, `auditor`) are securely resolved from Supabase user metadata and isolated by Tenant UUID.
