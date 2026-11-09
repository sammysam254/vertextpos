# Biometric Security Architecture & Protocol Specification

## 1. Zero Raw Biometric Policy

In accordance with strict security standards and global biometric data privacy laws (BIPA, GDPR Article 9, CCPA):
1. **No Raw Fingerprint Images:** Fingerprint bitmaps, TIFFs, or raster arrays are never captured, transmitted over HTTP, or stored on disk.
2. **No Proprietary Minutiae Templates in Application Tables:** Minutiae feature vectors ($x, y, \theta$) are never stored in standard POS relational tables.
3. **Hardware Enclave Isolation:** Template enrollment and minutiae matching are confined exclusively to the reader's secure element, TPM 2.0 enclave, or the Windows Biometric Framework engine.
4. **Cryptographic Identity Association:** The database records ONLY:
   - `credentialId`: Secure random identifier (e.g. `cred_alice_wbf_01`)
   - `userId`: Supervisor account ID
   - `publicKey`: SPKI PEM ECDSA P-256 public key
   - `algorithm`: `ES256` (ECDSA with SHA-256)
   - `signCount`: Monotonically increasing signature counter
   - `branchPermissions`: Array of authorized branch IDs (e.g. `["BR-001"]`)
   - `status`: `ACTIVE` or `REVOKED`

---

## 2. Cryptographic Challenge-Response Protocol

Every authorization prompt executes an asymmetric cryptographic challenge-response handshake:

```
Cashier Register                       POS Backend                    Biometric Reader
       │                                    │                                 │
       │─── 1. Request Suspension/Resume ──>│                                 │
       │                                    │─── 2. Generate Nonce ───────────│
       │                                    │    (32-byte cryptographically   │
       │                                    │     secure random hex;          │
       │<── 3. Return Challenge & Modal ────│     60-second TTL)              │
       │                                    │                                 │
       │─── 4. Supervisor Finger Scan ───────────────────────────────────────>│
       │                                                                      │ (Minutiae Matched)
       │                                                                      │ (Signs Payload with
       │                                                                      │  Enclave Private Key)
       │<── 5. Assertion (Signature, UserID, DeviceSerial) ───────────────────│
       │                                    │                                 │
       │─── 6. Submit Assertion & Nonce ───>│                                 │
       │                                    │─── 7. Verify:                   │
       │                                    │    • Challenge not expired/used │
       │                                    │    • Signature matches PubKey   │
       │                                    │    • SignCount incremented      │
       │                                    │    • Role == 'supervisor'       │
       │                                    │    • Branch == 'BR-001'         │
       │                                    │    • Not locked out             │
       │                                    │                                 │
       │<── 8. Authorization Granted/Denied │                                 │
       │       Display:                     │                                 │
       │       SUSPENSION AUTHORIZED        │                                 │
       │       Supervisor: [Name]           │                                 │
       │       Time: [Timestamp]            │                                 │
```

---

## 3. Threat Mitigation Matrix

| Threat Vector | Attack Scenario | Implemented Defense Mechanism |
| :--- | :--- | :--- |
| **Replay Attack** | Malicious actor captures valid biometric signature over network and replays it to resume order. | **Single-Use Challenge Nonces & Counter:** Nonces are stored with a 60s expiration and burned immediately upon verification attempt. Additionally, the `signCount` must strictly increment. |
| **Session Hijacking / Stale Session Reuse** | Cashier attempts to use supervisor's previous suspension authorization to authorize an unauthorized resumption. | **Fresh Authorization Mandate:** Suspension and Resumption require separate fresh cryptographic challenges. No prior session token can authorize a new action. |
| **Privilege Escalation** | Cashier places their own finger on reader to suspend or resume without a supervisor. | **Account Role & Permission Verification:** The biometric reader identifies the exact user account bound to the credential. Non-supervisor roles are rejected with `UNAUTHORIZED_ROLE` and logged. |
| **Cross-Branch Authorization** | Supervisor from Branch B attempts to authorize actions at Branch A. | **Branch-Level Scoping:** Every supervisor credential explicitly lists authorized branch IDs. Cross-branch authorization returns `BRANCH_UNAUTHORIZED`. |
| **Brute Force / Sensor Spoofing** | Repeatedly pressing fake biometric molds or incorrect fingers. | **Account Lockout:** 3 consecutive failed verification attempts lock the supervisor's biometric credential for 5 minutes. |
| **Hardware Tampering / Disconnection** | Reader is unplugged to force the system into a degraded, unauthenticated state. | **Fail-Secure Architecture:** Hardware disconnection locks the operation. The system never silently falls back to cashier authorization. |
| **Audit Log Tampering** | Rogue actor modifies log entries to conceal unauthorized actions. | **Cryptographic Integrity Hash:** Every audit record incorporates a SHA-256 hash checksum linking timestamp, user ID, register ID, and action. |

---

## 4. Emergency Fallback Procedure

When hardware is damaged, disconnected, or a supervisor account is locked:
1. Routine cashier/supervisor biometric authorization is disabled.
2. The **Emergency Fallback Override** workflow is invoked.
3. Requires:
   - High-privilege Store Administrator or General Manager credentials.
   - Master Emergency Passcode verified via PBKDF2 with SHA-512 and salt.
   - Formal selection of incident reason (`HARDWARE_DISCONNECTED`, `SENSOR_FAULT`, `ACCOUNT_LOCKED`).
   - Incident notes recorded in the central audit ledger.
4. An emergency override token is generated and flagged in the audit system with high severity (`EMERGENCY_OVERRIDE`).

