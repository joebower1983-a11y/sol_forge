# SolForge 🔥

A value-capture vault protocol on Solana with fee accrual, automatic & manual SOL burning (deflationary mechanics), reward distribution, and timelocked governance.

## Features

- **Fee Capture** — Programmable vault collects SOL fees from users/programs
- **Auto-Burn** — Configurable % of incoming fees burned automatically
- **Manual Burn** — Authority can burn additional SOL for extra deflation
- **Reward Distribution** — Authority distributes captured value to any address
- **Timelocked Governance** — Parameter changes require a delay period (24h default)
- **Dust Protection** — Minimum amounts enforced on burns & distributions

## Instructions

| Instruction | Access | Description |
|---|---|---|
| `initialize_vault` | Once | Create the singleton PDA vault |
| `accrue_fee` | Anyone | Deposit SOL with auto-burn |
| `burn_sol` | Authority | Manual SOL burn from vault |
| `distribute_rewards` | Authority | Send SOL to any recipient |
| `propose_parameter_update` | Authority | Start timelocked parameter change |
| `execute_parameter_update` | Authority | Apply change after timelock expires |
| `cancel_parameter_proposal` | Authority | Cancel pending change |

## Build

Use [Solana Playground](https://beta.solpg.io) or locally with Anchor:

```bash
anchor build
anchor deploy
```

## License

MIT
