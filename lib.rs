use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("F1aLM6gPxEmoGRCT84ZYTSWAgiaaf3m4JHabr4nkBiHo");

// Solana's native incinerator address (1nc1nerator11111111111111111111111111111111)
pub const INCINERATOR: Pubkey = Pubkey::new_from_array([
    0x00, 0x33, 0x90, 0x72, 0x8d, 0x34, 0x11, 0x60,
    0x79, 0xbd, 0xc9, 0x11, 0xbf, 0xff, 0x00, 0xdb,
    0xd4, 0x4d, 0x2e, 0xcd, 0xcc, 0xf7, 0x9c, 0xa6,
    0xe1, 0x00, 0x38, 0xe1, 0x00, 0x00, 0x00, 0x00,
]);
pub const DEFAULT_DELAY_SECONDS: i64 = 86_400;       // 24 hours
pub const MIN_DELAY_SECONDS: i64 = 3_600;            // 1 hour
pub const MAX_DELAY_SECONDS: i64 = 604_800;          // 7 days
pub const MIN_BURN_AMOUNT_LAMPORTS: u64 = 1_000_000; // 0.001 SOL

#[program]
pub mod sol_forge {
    use super::*;

    /// Initialize singleton PDA vault
    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        fee_bps: u16,
        burn_bps: u16,
        delay_seconds: Option<i64>,
    ) -> Result<()> {
        require!(fee_bps <= 10_000, ErrorCode::InvalidFeeRate);
        require!(burn_bps <= 10_000, ErrorCode::InvalidBurnPercentage);

        let delay = delay_seconds.unwrap_or(DEFAULT_DELAY_SECONDS);
        require!(
            delay >= MIN_DELAY_SECONDS && delay <= MAX_DELAY_SECONDS,
            ErrorCode::InvalidDelay
        );

        let vault = &mut ctx.accounts.vault;
        *vault = Vault {
            authority: *ctx.accounts.authority.key,
            total_accrued: 0,
            fee_basis_points: fee_bps,
            burn_percentage_bps: burn_bps,
            delay_seconds: delay,
            bump: ctx.bumps.vault,
            pending_burn_percentage_bps: None,
            pending_delay_seconds: None,
            pending_release_time: 0,
        };

        msg!(
            "SolForge vault initialized | authority={} fee={} bps burn={} bps delay={}s",
            vault.authority,
            fee_bps,
            burn_bps,
            delay
        );
        Ok(())
    }

    /// Anyone can pay SOL into the vault (real fee capture).
    /// A portion is auto-burned according to current burn %.
    pub fn accrue_fee(ctx: Context<AccrueFee>, amount_lamports: u64) -> Result<()> {
        require!(amount_lamports > 0, ErrorCode::AmountTooSmall);

        let vault = &mut ctx.accounts.vault;

        // Transfer SOL from payer → vault PDA
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                },
            ),
            amount_lamports,
        )?;

        let burn_amount =
            ((amount_lamports as u128) * vault.burn_percentage_bps as u128 / 10_000) as u64;
        let net_amount = amount_lamports.saturating_sub(burn_amount);

        // Auto-burn portion → incinerator
        if burn_amount > 0 {
            let seeds = &[b"vault".as_ref(), &[vault.bump]];
            let signer_seeds = &[&seeds[..]];

            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.incinerator.to_account_info(),
                    },
                    signer_seeds,
                ),
                burn_amount,
            )?;
        }

        vault.total_accrued = vault
            .total_accrued
            .checked_add(net_amount)
            .ok_or(ErrorCode::ArithmeticOverflow)?;

        emit!(FeeAccrued {
            payer: *ctx.accounts.payer.key,
            gross: amount_lamports,
            burned: burn_amount,
            net: net_amount,
            total_accrued: vault.total_accrued,
        });
        Ok(())
    }

    /// Authority manually burns SOL from vault (extra deflation)
    pub fn burn_sol(ctx: Context<BurnSol>, amount_lamports: u64) -> Result<()> {
        require!(
            amount_lamports >= MIN_BURN_AMOUNT_LAMPORTS,
            ErrorCode::AmountTooSmall
        );
        require!(
            amount_lamports <= ctx.accounts.vault.total_accrued,
            ErrorCode::InsufficientBalance
        );

        let vault = &mut ctx.accounts.vault;
        let seeds = &[b"vault".as_ref(), &[vault.bump]];
        let signer = &[&seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.incinerator.to_account_info(),
                },
                signer,
            ),
            amount_lamports,
        )?;

        vault.total_accrued = vault
            .total_accrued
            .checked_sub(amount_lamports)
            .ok_or(ErrorCode::ArithmeticUnderflow)?;

        emit!(SolBurned {
            amount: amount_lamports,
            remaining: vault.total_accrued,
        });
        Ok(())
    }

    /// Authority sends SOL from vault to any address (rewards, treasury, etc.)
    pub fn distribute_rewards(
        ctx: Context<DistributeRewards>,
        amount_lamports: u64,
    ) -> Result<()> {
        require!(
            amount_lamports >= MIN_BURN_AMOUNT_LAMPORTS,
            ErrorCode::AmountTooSmall
        );
        require!(
            amount_lamports <= ctx.accounts.vault.total_accrued,
            ErrorCode::InsufficientBalance
        );

        let vault = &mut ctx.accounts.vault;
        let seeds = &[b"vault".as_ref(), &[vault.bump]];
        let signer = &[&seeds[..]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.recipient.to_account_info(),
                },
                signer,
            ),
            amount_lamports,
        )?;

        vault.total_accrued = vault
            .total_accrued
            .checked_sub(amount_lamports)
            .ok_or(ErrorCode::ArithmeticUnderflow)?;

        emit!(RewardsDistributed {
            recipient: *ctx.accounts.recipient.key,
            amount: amount_lamports,
            remaining: vault.total_accrued,
        });
        Ok(())
    }

    // ─── Governance (timelocked parameter updates) ─────────────────────

    pub fn propose_parameter_update(
        ctx: Context<ProposeParameterUpdate>,
        new_burn_bps: Option<u16>,
        new_delay_secs: Option<i64>,
    ) -> Result<()> {
        require!(
            new_burn_bps.is_some() || new_delay_secs.is_some(),
            ErrorCode::NoChangeProposed
        );

        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        if let Some(bps) = new_burn_bps {
            require!(bps <= 10_000, ErrorCode::InvalidBurnPercentage);
            vault.pending_burn_percentage_bps = Some(bps);
        }
        if let Some(secs) = new_delay_secs {
            require!(
                secs >= MIN_DELAY_SECONDS && secs <= MAX_DELAY_SECONDS,
                ErrorCode::InvalidDelay
            );
            vault.pending_delay_seconds = Some(secs);
        }

        vault.pending_release_time = clock.unix_timestamp + vault.delay_seconds;

        emit!(ParameterUpdateProposed {
            proposed_burn_bps: new_burn_bps,
            proposed_delay_secs: new_delay_secs,
            release_at: vault.pending_release_time,
        });
        Ok(())
    }

    pub fn execute_parameter_update(ctx: Context<ExecuteParameterUpdate>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        let clock = Clock::get()?;

        require!(
            vault.pending_burn_percentage_bps.is_some() || vault.pending_delay_seconds.is_some(),
            ErrorCode::NoPendingUpdate
        );
        require!(
            clock.unix_timestamp >= vault.pending_release_time,
            ErrorCode::TimelockNotExpired
        );

        if let Some(bps) = vault.pending_burn_percentage_bps {
            vault.burn_percentage_bps = bps;
        }
        if let Some(secs) = vault.pending_delay_seconds {
            vault.delay_seconds = secs;
        }

        vault.pending_burn_percentage_bps = None;
        vault.pending_delay_seconds = None;
        vault.pending_release_time = 0;

        emit!(ParameterUpdateExecuted {});
        Ok(())
    }

    pub fn cancel_parameter_proposal(ctx: Context<CancelParameterProposal>) -> Result<()> {
        let vault = &mut ctx.accounts.vault;

        require!(
            vault.pending_burn_percentage_bps.is_some() || vault.pending_delay_seconds.is_some(),
            ErrorCode::NoPendingUpdate
        );

        vault.pending_burn_percentage_bps = None;
        vault.pending_delay_seconds = None;
        vault.pending_release_time = 0;

        emit!(ParameterUpdateCanceled {});
        Ok(())
    }
}

// ─── Account Definitions ──────────────────────────────────────────────────────

#[account]
pub struct Vault {
    pub authority: Pubkey,
    pub total_accrued: u64,
    pub fee_basis_points: u16,
    pub burn_percentage_bps: u16,
    pub delay_seconds: i64,
    pub bump: u8,
    // Pending governance update
    pub pending_burn_percentage_bps: Option<u16>,
    pub pending_delay_seconds: Option<i64>,
    pub pending_release_time: i64,
}

impl Vault {
    pub const INIT_SPACE: usize = 8  // discriminator
        + 32  // authority: Pubkey
        + 8   // total_accrued: u64
        + 2   // fee_basis_points: u16
        + 2   // burn_percentage_bps: u16
        + 8   // delay_seconds: i64
        + 1   // bump: u8
        + (1 + 2)  // Option<u16> pending_burn_percentage_bps
        + (1 + 8)  // Option<i64> pending_delay_seconds
        + 8;  // pending_release_time: i64
}

// ─── Instruction Account Structs ──────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(fee_bps: u16, burn_bps: u16, _delay: Option<i64>)]
pub struct InitializeVault<'info> {
    #[account(
        init,
        payer = authority,
        space = Vault::INIT_SPACE,
        seeds = [b"vault"],
        bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AccrueFee<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Solana incinerator address — no data, no owner check needed
    #[account(mut, address = INCINERATOR)]
    pub incinerator: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnSol<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, constraint = authority.key() == vault.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
    /// CHECK: Solana incinerator address
    #[account(mut, address = INCINERATOR)]
    pub incinerator: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DistributeRewards<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(mut, constraint = authority.key() == vault.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
    /// CHECK: Any recipient address chosen by authority
    #[account(mut)]
    pub recipient: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ProposeParameterUpdate<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = authority.key() == vault.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct ExecuteParameterUpdate<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = authority.key() == vault.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CancelParameterProposal<'info> {
    #[account(mut, seeds = [b"vault"], bump = vault.bump)]
    pub vault: Account<'info, Vault>,
    #[account(constraint = authority.key() == vault.authority @ ErrorCode::Unauthorized)]
    pub authority: Signer<'info>,
}

// ─── Events ───────────────────────────────────────────────────────────────────

#[event]
pub struct FeeAccrued {
    pub payer: Pubkey,
    pub gross: u64,
    pub burned: u64,
    pub net: u64,
    pub total_accrued: u64,
}

#[event]
pub struct SolBurned {
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct RewardsDistributed {
    pub recipient: Pubkey,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct ParameterUpdateProposed {
    pub proposed_burn_bps: Option<u16>,
    pub proposed_delay_secs: Option<i64>,
    pub release_at: i64,
}

#[event]
pub struct ParameterUpdateExecuted {}

#[event]
pub struct ParameterUpdateCanceled {}

// ─── Errors ───────────────────────────────────────────────────────────────────

#[error_code]
pub enum ErrorCode {
    #[msg("Fee or burn rate > 100% (10000 bps)")]
    InvalidFeeRate,
    #[msg("Burn percentage > 10000 bps")]
    InvalidBurnPercentage,
    #[msg("Delay outside allowed range")]
    InvalidDelay,
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    #[msg("Arithmetic underflow")]
    ArithmeticUnderflow,
    #[msg("Insufficient vault balance")]
    InsufficientBalance,
    #[msg("Amount below dust protection threshold")]
    AmountTooSmall,
    #[msg("No parameter change was proposed")]
    NoChangeProposed,
    #[msg("Timelock has not yet expired")]
    TimelockNotExpired,
    #[msg("No pending governance update exists")]
    NoPendingUpdate,
    #[msg("Unauthorized caller")]
    Unauthorized,
}
