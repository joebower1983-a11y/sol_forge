# SolForge Protocol — Whitepaper

**Version 1.0 · February 2026**

**Program ID:** `F1aLM6gPxEmoGRCT84ZYTSWAgiaaf3m4JHabr4nkBiHo`

---

## Table of Contents

1. [Abstract](#1-abstract)
2. [Problem Statement](#2-problem-statement)
3. [Solution — The SolForge Vault](#3-solution--the-solforge-vault)
4. [Architecture](#4-architecture)
5. [Tokenomics & Deflationary Model](#5-tokenomics--deflationary-model)
6. [Security](#6-security)
7. [Use Cases](#7-use-cases)
8. [Roadmap](#8-roadmap)
9. [Conclusion](#9-conclusion)

---

## 1. Abstract

SolForge is an on-chain Solana protocol that provides a permissionless, deflationary value-capture vault for protocols, DAOs, and applications built on Solana. By routing protocol-generated fees through a singleton Program Derived Address (PDA) vault, SolForge automatically burns a configurable percentage of incoming SOL — permanently removing it from circulation — while retaining the remainder for reward distribution or treasury operations. All governance parameter changes are enforced through an on-chain timelock, ensuring transparency and preventing unilateral, instantaneous modifications.

---

## 2. Problem Statement

### 2.1 The Value Leakage Problem

Solana's high throughput and sub-cent transaction fees have driven explosive growth in DeFi, NFT marketplaces, and launchpad platforms. However, most protocols on Solana lack a structured mechanism for **capturing and compounding the value they generate**. Fee revenue is typically:

- Sent directly to an EOA (externally owned account) controlled by a single team member, creating trust and key-person risk.
- Scattered across multiple wallets with no on-chain accounting or auditability.
- Never recycled into deflationary pressure for the ecosystem's native asset (SOL).

### 2.2 Absence of Native Deflation

Unlike Ethereum's EIP-1559 base-fee burn, Solana's fee model does not include a significant burn component at the protocol level. While Solana introduced partial fee burning, the rate is modest. Protocols that wish to introduce additional deflationary pressure for their communities — or for SOL itself — have no standardized, auditable primitive to do so.

### 2.3 Governance Trust Assumptions

When protocol parameters (fee rates, burn percentages) are controlled by a single admin key with no delay, users must trust that the authority will not make sudden, adverse changes. This is an unacceptable trust assumption for protocols managing meaningful TVL.

---

## 3. Solution — The SolForge Vault

SolForge introduces a **singleton PDA vault** that serves as a protocol's canonical fee-collection, auto-burn, and reward-distribution engine.

### Core Mechanics

| Capability | Description |
|---|---|
| **Fee Accrual** | Any account can deposit SOL into the vault via `accrue_fee`. A configurable portion is **instantly and atomically burned** by transferring it to Solana's native incinerator address. |
| **Manual Burn** | The vault authority can trigger additional burns at any time via `burn_sol`, enabling strategic deflationary events. |
| **Reward Distribution** | The authority can send vault funds to any recipient via `distribute_rewards` — staking pools, treasuries, contributors, or community grants. |
| **Timelocked Governance** | Changes to burn percentage or timelock delay must be **proposed**, then **executed** only after the timelock period expires (default 24 hours, configurable 1 hour – 7 days). Proposals can be canceled but never fast-tracked. |

### Design Philosophy

- **Permissionless inflow:** Anyone can pay fees into the vault. No allowlists.
- **Controlled outflow:** Only the designated authority can withdraw or burn.
- **Atomic auto-burn:** Burn happens in the same transaction as deposit — no second step, no race condition.
- **Transparent accounting:** `total_accrued` tracks net vault balance on-chain; all mutations emit events.

---

## 4. Architecture

### 4.1 PDA Vault (Singleton)

The vault is derived from a single seed (`"vault"`) and stored as a PDA with an Anchor discriminator:

```
seeds = [b"vault"]
```

This guarantees exactly **one vault per program deployment**. The PDA holds SOL directly (as lamports in its account balance) and maintains the following state:

| Field | Type | Description |
|---|---|---|
| `authority` | `Pubkey` | The sole address authorized for withdrawals and governance |
| `total_accrued` | `u64` | Net SOL retained in the vault (after auto-burns) |
| `fee_basis_points` | `u16` | Protocol fee rate in basis points (informational / integrator use) |
| `burn_percentage_bps` | `u16` | Percentage of each deposit auto-burned (0–10,000 bps = 0–100%) |
| `delay_seconds` | `i64` | Governance timelock duration |
| `bump` | `u8` | PDA bump seed |
| `pending_burn_percentage_bps` | `Option<u16>` | Proposed new burn rate (if any) |
| `pending_delay_seconds` | `Option<i64>` | Proposed new timelock (if any) |
| `pending_release_time` | `i64` | Unix timestamp after which the pending proposal can execute |

**Total on-chain footprint:** 81 bytes (including 8-byte discriminator).

### 4.2 Fee Accrual & Auto-Burn Flow

```
Payer ──SOL──▶ Vault PDA
                 │
                 ├── burn_bps% ──▶ Incinerator (1nc1nerator11...111)
                 │                  [permanently destroyed]
                 │
                 └── (100% - burn_bps%) retained in vault
                      └── total_accrued += net_amount
```

The burn is executed as a CPI `system_program::transfer` signed by the vault PDA using its seeds. This is atomic — if the burn transfer fails, the entire deposit reverts.

### 4.3 Manual Burn

The authority calls `burn_sol(amount)` to send additional lamports from the vault to the incinerator. This provides a lever for **strategic deflation** — for example, burning accumulated fees during a community-voted event.

**Constraints:**
- Minimum burn: 0.001 SOL (1,000,000 lamports) — dust protection.
- Cannot exceed `total_accrued`.

### 4.4 Reward Distribution

`distribute_rewards(amount)` transfers SOL from the vault to any arbitrary recipient. This is the mechanism for:

- Staking reward payouts
- Treasury funding
- Contributor compensation
- Community grants

Same minimum-amount and balance constraints as manual burn.

### 4.5 Timelocked Governance

Parameter changes follow a **propose → wait → execute** pattern:

```
Authority calls propose_parameter_update(new_burn_bps, new_delay_secs)
    │
    ▼
pending_release_time = now + current delay_seconds
    │
    │  ... timelock period passes ...
    │
    ▼
Authority calls execute_parameter_update()
    → Parameters applied only if clock >= pending_release_time
```

- **Propose:** Sets pending values and release timestamp. Either or both parameters may be proposed simultaneously.
- **Execute:** Applies pending values only after the timelock expires. Clears pending state.
- **Cancel:** Authority can cancel a pending proposal at any time (reverts to current values).

This ensures that any parameter change is publicly visible on-chain for at least `delay_seconds` before it takes effect, giving users and integrators time to react.

### 4.6 Events

All state-changing instructions emit Anchor events for off-chain indexing:

| Event | Fields |
|---|---|
| `FeeAccrued` | `payer`, `gross`, `burned`, `net`, `total_accrued` |
| `SolBurned` | `amount`, `remaining` |
| `RewardsDistributed` | `recipient`, `amount`, `remaining` |
| `ParameterUpdateProposed` | `proposed_burn_bps`, `proposed_delay_secs`, `release_at` |
| `ParameterUpdateExecuted` | *(empty — current state readable from account)* |
| `ParameterUpdateCanceled` | *(empty)* |

---

## 5. Tokenomics & Deflationary Model

SolForge operates on **native SOL**, not a custom token. This is a deliberate design choice:

- **No token risk:** No additional token to manage, list, or secure. No liquidity bootstrapping problem.
- **Direct SOL deflation:** Every burn permanently reduces SOL circulating supply by sending lamports to the Solana incinerator — an address with no private key.
- **Composable:** Any protocol that generates SOL-denominated fees can integrate SolForge without requiring users to hold a new asset.

### Deflationary Dynamics

Given a protocol routing **V** SOL per epoch through SolForge with a burn rate of **B** bps:

```
SOL burned per epoch = V × (B / 10,000)
SOL retained in vault = V × (1 − B / 10,000)
```

At a 20% burn rate (2,000 bps) and 1,000 SOL daily volume:
- **200 SOL burned daily** (permanently removed from supply)
- **800 SOL retained** for rewards/treasury

As multiple protocols adopt SolForge, the aggregate burn compounds, creating ecosystem-wide deflationary pressure proportional to on-chain economic activity.

### Configurable Parameters

| Parameter | Range | Default |
|---|---|---|
| Burn Percentage | 0 – 10,000 bps (0% – 100%) | Set at initialization |
| Fee Basis Points | 0 – 10,000 bps | Set at initialization |
| Timelock Delay | 3,600s – 604,800s (1h – 7d) | 86,400s (24h) |

---

## 6. Security

### 6.1 Timelock Enforcement

All governance changes are subject to a mandatory timelock (minimum 1 hour, maximum 7 days). This prevents:

- **Rug-by-parameter:** An authority cannot instantly set burn to 100% to drain deposits.
- **Silent changes:** Every proposal is recorded on-chain with a release timestamp, indexable by any observer.

The timelock itself is governed by the timelock — changing `delay_seconds` also requires waiting the current delay period.

### 6.2 Authority Constraints

- Only the `authority` pubkey (set at initialization) can call `burn_sol`, `distribute_rewards`, or any governance instruction.
- Anchor's `constraint` attribute enforces `authority.key() == vault.authority` at the instruction level, producing a clear `Unauthorized` error on mismatch.
- The authority cannot be changed post-initialization in the current version, eliminating authority-transfer attack vectors.

### 6.3 Dust Protection

A minimum transaction threshold of **0.001 SOL** (1,000,000 lamports) is enforced on `burn_sol` and `distribute_rewards`. This prevents:

- Griefing via micro-transactions that waste compute units.
- Vault state pollution with economically meaningless operations.

Note: `accrue_fee` accepts any amount > 0 lamports to avoid blocking legitimate small fee payments.

### 6.4 Arithmetic Safety

All balance mutations use Rust's `checked_add` / `checked_sub`, returning explicit `ArithmeticOverflow` / `ArithmeticUnderflow` errors rather than silently wrapping. The burn calculation uses `u128` intermediate precision to prevent overflow on large deposits.

### 6.5 Incinerator Address Validation

The incinerator account is validated via `address = INCINERATOR` in the Anchor account struct, ensuring that burn transfers can only target the canonical Solana incinerator (`1nc1nerator11111111111111111111111111111111`). This address has no known private key — lamports sent there are irrecoverable.

### 6.6 PDA Seed Security

The vault PDA uses a fixed seed (`b"vault"`) with a stored bump, verified on every instruction via `seeds = [b"vault"], bump = vault.bump`. This prevents:

- PDA substitution attacks (passing a different account).
- Bump manipulation (the bump is stored and checked, not recomputed).

---

## 7. Use Cases

### 7.1 DEX Fee Collection

A decentralized exchange can route trading fees through SolForge:

1. On each swap, the DEX program CPIs into `accrue_fee` with the fee amount.
2. A configurable portion is auto-burned, creating deflationary pressure that benefits all SOL holders.
3. Retained funds are periodically distributed to liquidity providers via `distribute_rewards`.

### 7.2 Launchpad Revenue

Token launchpads collect listing fees, allocation fees, and platform commissions. SolForge provides:

- **Transparent accounting:** All revenue is visible on-chain in a single vault.
- **Community alignment:** Burning a portion of revenue demonstrates commitment to ecosystem value.
- **Automated distribution:** Staking rewards for platform token holders can be distributed directly from the vault.

### 7.3 NFT Marketplace Royalties

NFT marketplaces can route creator royalties or platform fees through SolForge:

- Creators receive their share via `distribute_rewards`.
- The marketplace burns a portion, aligning incentives between the platform and the broader Solana ecosystem.
- On-chain event logs provide a complete audit trail for royalty accounting.

### 7.4 DAO Treasury Management

DAOs can use SolForge as a governed treasury:

- Members propose parameter changes; the timelock provides a window for community review.
- Surplus funds are burned to benefit token holders rather than sitting idle.
- Reward distributions can fund grants, bounties, or contributor payments.

### 7.5 Protocol-Owned Liquidity (POL) Recycling

Protocols with SOL-denominated POL revenue can continuously route earnings through SolForge, compounding deflationary pressure while maintaining a distributable reserve.

---

## 8. Roadmap

### Phase 1 — Foundation (Current)
- ✅ Core vault program (Anchor/Rust)
- ✅ Fee accrual with atomic auto-burn
- ✅ Manual burn and reward distribution
- ✅ Timelocked governance (propose / execute / cancel)
- ✅ Full event emission for off-chain indexing

### Phase 2 — Ecosystem Integration
- 🔲 TypeScript SDK and CLI for vault management
- 🔲 CPI integration guide for composing protocols
- 🔲 Dashboard UI (real-time vault stats, burn history, governance proposals)
- 🔲 Devnet deployment and public testnet

### Phase 3 — Governance Evolution
- 🔲 Multi-signature authority support (Squads / Multisig integration)
- 🔲 Authority transfer with timelocked two-step handoff
- 🔲 On-chain voting for parameter proposals (token-weighted or NFT-gated)

### Phase 4 — Advanced Features
- 🔲 SPL Token vault support (burn and distribute any SPL token, not just SOL)
- 🔲 Multi-vault deployment (per-protocol vault instances via additional seeds)
- 🔲 Automated reward scheduling (epoch-based distribution triggers)
- 🔲 Cross-program composability standards (SolForge Interface Definition)

### Phase 5 — Decentralization
- 🔲 Fully on-chain governance DAO controlling the program upgrade authority
- 🔲 Immutable program deployment option (freeze upgrade authority)
- 🔲 Community-governed burn rate voting

---

## 9. Conclusion

SolForge addresses a fundamental gap in the Solana ecosystem: the absence of a standardized, transparent, and secure value-capture primitive. By combining permissionless fee accrual, atomic auto-burn, flexible reward distribution, and timelocked governance into a single on-chain program, SolForge provides protocols with a turnkey solution for:

1. **Capturing value** in a single, auditable vault.
2. **Creating deflationary pressure** on SOL through provable, permanent burns.
3. **Distributing rewards** to stakeholders with on-chain accountability.
4. **Governing parameters** transparently with enforced time delays.

The protocol is minimal by design — 81 bytes of on-chain state, seven instructions, and zero external dependencies beyond Anchor and the Solana system program. This simplicity is a feature: fewer lines of code mean a smaller attack surface, easier auditability, and broader composability.

SolForge is infrastructure. It is the forge where protocol revenue is refined — value captured, waste burned, rewards distributed — all on-chain, all verifiable, all permanent.

---

*SolForge is open source. Contributions, audits, and integrations are welcome.*

*Program ID: `F1aLM6gPxEmoGRCT84ZYTSWAgiaaf3m4JHabr4nkBiHo`*
