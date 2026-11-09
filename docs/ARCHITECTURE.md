# Supermarket POS Biometric Supervisor Authorization — System Architecture

## Architecture Overview

```mermaid
flowchart TD
    subgraph Frontend["POS Client (Touch Terminal)"]
        UI["Cashier Checkout Screen"]
        MODAL["Biometric Supervisor Auth Modal"]
        EMERG["Emergency Override Dialog"]
        SETTINGS["Supervisor Security Portal"]
    end

    subgraph Backend["POS Node.js Engine (Port 3000)"]
        ROUTER["REST API Router"]
        TX_SVC["Transaction Service"]
        SESS_MGR["Session & Replay Manager"]
        EMERG_SVC["Emergency Override Service"]
        AUDIT["Tamper-Evident Audit Logger"]
    end

    subgraph HAL["Biometric Hardware Adapter Layer"]
        ADAPTER["Biometric Adapter (HAL)"]
        DEV_MGR["Device Health Monitor"]
        WBF["WBF Driver (WinBio)"]
        WEBAUTHN["WebAuthn Platform Driver"]
        USB_SDK["Direct USB SDK Driver"]
    end

    subgraph Storage["Persistent Store"]
        DB[("ACID JSON Datastore")]
    end

    UI -->|1. Request Suspension/Resumption| ROUTER
    ROUTER --> TX_SVC
    TX_SVC -->|2. Create Challenge| SESS_MGR
    SESS_MGR -->|3. Return Challenge & 60s TTL| MODAL
    MODAL -->|4. Fingerprint Scan Assertion| ROUTER
    ROUTER --> ADAPTER
    ADAPTER --> DEV_MGR
    ADAPTER --> WBF
    ADAPTER --> WEBAUTHN
    ADAPTER --> USB_SDK
    ADAPTER -->|5. Verify ECDSA Signature| DB
    ADAPTER -->|6. Verify Supervisor Role & Branch| TX_SVC
    TX_SVC -->|7. Persist Held State / Restore Cart| DB
    TX_SVC -->|8. Log Outcome| AUDIT
    AUDIT --> DB
    EMERG -->|Emergency Admin Passcode| ROUTER
    ROUTER --> EMERG_SVC
    EMERG_SVC --> AUDIT
```

## Key Workflows

### 1. Suspending a Transaction
1. **Cashier Action:** Cashier clicks `REQUEST SUSPENSION`.
2. **Challenge Creation:** Backend creates a single-use 32-byte nonce expiring in 60s.
3. **Biometric Prompt:** System displays supervisor fingerprint authorization window.
4. **Biometric Scan:** Supervisor touches reader; reader hardware signs challenge with ECDSA P-256 private key.
5. **Validation:** Backend verifies signature against enrolled public key, checks active status, supervisor role, and branch assignment (`BR-001`).
6. **State Save:** Cart items, quantities, prices, and partial payments are snapshotted in `SUSPENDED` state.
7. **Display & Release:** UI displays:
   ```
   SUSPENSION AUTHORIZED
   Supervisor: [Supervisor Name]
   Time: [Timestamp]
   ```
   POS register clears and becomes immediately available for the next customer.

### 2. Resuming a Suspended Transaction
1. **Cashier Action:** Cashier selects held transaction from Suspended Orders.
2. **Fresh Challenge:** System issues a brand new single-use cryptographic challenge (old tokens cannot be reused).
3. **Biometric Scan:** Supervisor places finger on reader.
4. **Validation:** Hardware verifies fingerprint and signs the new challenge.
5. **State Recovery:** Original transaction is restored to `ACTIVE` state:
   - All products, quantities, prices are recovered.
   - All previous partial payments (cash, card, voucher) are validated and restored.
   - Balance due is accurately recalculated.
6. **Display:** UI displays:
   ```
   RESUMPTION AUTHORIZED
   Supervisor: [Supervisor Name]
   Time: [Timestamp]
   ```
   Cashier continues checkout seamlessly.

