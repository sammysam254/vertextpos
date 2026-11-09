# API Documentation: Enterprise Supermarket POS SaaS Platform

All endpoints require standard JSON encoding and tenant authentication headers (except public registration and Safaricom webhook callbacks).

Base URL: `http://localhost:3000/api`

---

## 1. Authentication & Tenant Management

### `POST /api/auth/register-tenant`
Registers a new supermarket business on the SaaS platform.
```json
// Request
{
  "businessName": "QuickMart Supermarkets Ltd",
  "slug": "quickmart",
  "kraPin": "P051987654A",
  "phone": "254711223344",
  "email": "owner@quickmart.ke",
  "password": "Password@2026!",
  "planId": "growth",
  "branchName": "Nairobi Westlands Branch"
}

// Response (201 Created)
{
  "success": true,
  "tenant": {
    "id": "tenant_quickmart_2026",
    "name": "QuickMart Supermarkets Ltd",
    "planId": "growth",
    "currency": "KES"
  },
  "user": {
    "id": "usr_owner_01",
    "email": "owner@quickmart.ke",
    "role": "owner"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC..."
}
```

### `POST /api/auth/login`
Authenticates a user and establishes tenant context.
```json
// Request
{
  "emailOrUsername": "cashier@metromart.ke",
  "password": "Cashier@2026!"
}
```

---

## 2. Lightning-Fast POS Checkout Endpoints

### `POST /api/pos/cart/item`
Adds an item to the active transaction cart in < 15ms.
```json
// Request
{
  "saleId": "TX-KES-10492",
  "barcode": "616110000018",
  "quantity": 2
}

// Response (200 OK)
{
  "success": true,
  "item": {
    "productId": "PRD-61611000001",
    "name": "Unga Jogoo Maize Flour 2kg",
    "barcode": "616110000018",
    "unitPrice": 185.00,
    "quantity": 2,
    "subtotal": 370.00,
    "vatRate": 0.00
  },
  "cart": {
    "subtotalKes": 370.00,
    "taxKes": 0.00,
    "totalKes": 370.00,
    "balanceDueKes": 370.00
  }
}
```

### `POST /api/pos/cart/tender-cash`
Records an instant cash payment tender with change calculation.
```json
// Request
{
  "saleId": "TX-KES-10492",
  "cashTendered": 500.00
}

// Response (200 OK)
{
  "success": true,
  "amountPaid": 370.00,
  "cashTendered": 500.00,
  "changeDueKes": 130.00,
  "status": "COMPLETED",
  "autoPrintTriggered": true
}
```

---

## 3. M-Pesa Daraja Payment Endpoints

### `POST /api/mpesa/stk-push`
Initiates an instantaneous Safaricom M-Pesa STK push prompt to the customer's mobile device.
```json
// Request
{
  "saleId": "TX-KES-10492",
  "customerPhone": "254712345678",
  "amountKes": 370.00
}

// Response (200 OK)
{
  "success": true,
  "checkoutRequestId": "ws_CO_09112026194200192837",
  "merchantRequestId": "29104-928192-1",
  "status": "PENDING",
  "customerMessage": "STK Push sent to 254712345678. Waiting for customer PIN."
}
```

### `POST /api/mpesa/callback` (Public Safaricom Webhook)
Receives and processes official Safaricom Daraja STK callback payload.
- Validates idempotency using `CheckoutRequestID`.
- Matches transaction, marks invoice `PAID`.
- Deducts inventory in the stock ledger.
- Pushes real-time SSE event to cashier terminal.

---

## 4. Cashier Shift Management

### `POST /api/shifts/open`
Opens a new register shift with float cash balance count.
```json
// Request
{
  "registerId": "REG-01",
  "openingFloatKes": 2500.00,
  "denominationCounts": {
    "1000": 1,
    "500": 2,
    "200": 2,
    "100": 1,
    "50": 0
  }
}
```

### `POST /api/shifts/close`
Closes the active shift, calculates expected cash vs actual physical count, and logs variance.
```json
// Request
{
  "shiftId": "SHIFT-20261109-01",
  "closingCashKes": 18450.00,
  "notes": "Evening shift close, float returned."
}

// Response (200 OK)
{
  "success": true,
  "expectedCashKes": 18450.00,
  "actualCashKes": 18450.00,
  "varianceKes": 0.00,
  "status": "BALANCED",
  "mpesaTotalKes": 42190.00,
  "totalSalesKes": 60640.00
}
```

---

## 5. Real-Time Events (Server-Sent Events)

### `GET /api/events`
Persistent HTTP stream for instantaneous event delivery:
- `PAYMENT_CONFIRMED`: Real-time M-Pesa settlement notification with receipt code.
- `PRINT_RECEIPT`: Automatic trigger for connected ESC/POS thermal printer.
- `QUEUE_UPDATE`: Suspended orders status update.

