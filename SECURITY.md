# Security Architecture & Threat Model: Supermarket POS SaaS

## 1. Multi-Tenant Data Isolation Guarantee
Every tenant's data is strictly partitioned by `tenant_id`.
- Tenant context is resolved on the backend from authenticated session tokens.
- Cross-tenant data access is blocked at the database query layer.
- Super Admin accounts have explicitly separated operational domains.

## 2. Zero-Trust Payment Processing (M-Pesa)
- **Frontend Success Ignored:** The client UI cannot declare a payment as completed.
- **Callback Verification:** Only cryptographically valid, idempotent Safaricom callbacks or verified query responses transition an invoice from `PENDING` to `PAID`.
- **Duplicate Callback Protection:** `CheckoutRequestID` and `MpesaReceiptNumber` are guarded by unique constraints. If Safaricom retries a webhook callback, it is processed idempotently without duplicate stock deductions.

## 3. Biometric & Supervisor Control Protection
- **Zero Raw Biometric Storage:** Asymmetric cryptographic signatures (ECDSA P-256) verify supervisor identity without storing raw minutiae or images.
- **Replay Attack Defense:** 60-second single-use challenge nonces burned upon first presentation.
- **Fail-Secure Defaults:** Hardware disconnections or sensor faults trigger fail-secure locks requiring Store Director / Admin emergency passcode overrides.

## 4. Cryptographic Audit Ledger
Every sensitive operation (price overrides, discounts, voids, refunds, stock adjustments, cashier drawer open, shifts) is recorded in an immutable audit ledger with SHA-256 integrity checksums.

