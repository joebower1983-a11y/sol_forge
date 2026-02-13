import {
  Program,
  AnchorProvider,
  BN,
  Idl,
  IdlAccounts,
} from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  Connection,
  Keypair,
  TransactionSignature,
} from "@solana/web3.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROGRAM_ID = new PublicKey(
  "F1aLM6gPxEmoGRCT84ZYTSWAgiaaf3m4JHabr4nkBiHo"
);

/** Solana native incinerator address */
export const INCINERATOR = new PublicKey(
  "1nc1nerator11111111111111111111111111111111"
);

const VAULT_SEED = Buffer.from("vault");

// ---------------------------------------------------------------------------
// Vault account type (mirrors on-chain Vault struct)
// ---------------------------------------------------------------------------

export interface VaultState {
  authority: PublicKey;
  totalAccrued: BN;
  feeBasisPoints: number;
  burnPercentageBps: number;
  delaySeconds: BN;
  bump: number;
  pendingBurnPercentageBps: number | null;
  pendingDelaySeconds: BN | null;
  pendingReleaseTime: BN;
}

// ---------------------------------------------------------------------------
// SolForge Client SDK
// ---------------------------------------------------------------------------

export class SolForgeClient {
  readonly program: Program;
  readonly provider: AnchorProvider;

  /** Vault PDA address (singleton) */
  readonly vaultPda: PublicKey;
  readonly vaultBump: number;

  private constructor(
    program: Program,
    provider: AnchorProvider,
    vaultPda: PublicKey,
    vaultBump: number
  ) {
    this.program = program;
    this.provider = provider;
    this.vaultPda = vaultPda;
    this.vaultBump = vaultBump;
  }

  /**
   * Create a new SolForgeClient.
   *
   * @param provider  An `AnchorProvider` with wallet & connection.
   * @param idl       The parsed IDL JSON for the SolForge program.
   * @param programId Override program ID (defaults to on-chain address).
   */
  static create(
    provider: AnchorProvider,
    idl: Idl,
    programId: PublicKey = PROGRAM_ID
  ): SolForgeClient {
    const program = new Program(idl, programId, provider);
    const [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [VAULT_SEED],
      programId
    );
    return new SolForgeClient(program, provider, vaultPda, vaultBump);
  }

  // -----------------------------------------------------------------------
  // Instructions
  // -----------------------------------------------------------------------

  /**
   * Initialize the singleton vault PDA.
   *
   * @param feeBps        Fee rate in basis points (0-10 000).
   * @param burnBps       Burn percentage in basis points (0-10 000).
   * @param delaySeconds  Governance timelock delay (optional, default 86 400).
   */
  async initializeVault(
    feeBps: number,
    burnBps: number,
    delaySeconds?: number
  ): Promise<TransactionSignature> {
    const authority = this.provider.wallet.publicKey;

    return this.program.methods
      .initializeVault(feeBps, burnBps, delaySeconds ? new BN(delaySeconds) : null)
      .accounts({
        vault: this.vaultPda,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Pay SOL into the vault. A portion is auto-burned per the current burn %.
   *
   * @param amountLamports Amount of lamports to accrue.
   */
  async accrueFee(amountLamports: BN | number): Promise<TransactionSignature> {
    const amount =
      typeof amountLamports === "number"
        ? new BN(amountLamports)
        : amountLamports;

    return this.program.methods
      .accrueFee(amount)
      .accounts({
        vault: this.vaultPda,
        payer: this.provider.wallet.publicKey,
        incinerator: INCINERATOR,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Authority manually burns SOL from the vault to the incinerator.
   *
   * @param amountLamports Amount of lamports to burn (≥ 1 000 000).
   */
  async burnSol(amountLamports: BN | number): Promise<TransactionSignature> {
    const amount =
      typeof amountLamports === "number"
        ? new BN(amountLamports)
        : amountLamports;

    return this.program.methods
      .burnSol(amount)
      .accounts({
        vault: this.vaultPda,
        authority: this.provider.wallet.publicKey,
        incinerator: INCINERATOR,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Authority distributes SOL from the vault to any recipient.
   *
   * @param recipient      Destination public key.
   * @param amountLamports Amount of lamports to send (≥ 1 000 000).
   */
  async distributeRewards(
    recipient: PublicKey,
    amountLamports: BN | number
  ): Promise<TransactionSignature> {
    const amount =
      typeof amountLamports === "number"
        ? new BN(amountLamports)
        : amountLamports;

    return this.program.methods
      .distributeRewards(amount)
      .accounts({
        vault: this.vaultPda,
        authority: this.provider.wallet.publicKey,
        recipient,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /**
   * Propose a timelocked parameter update (burn % and/or delay).
   *
   * @param newBurnBps     New burn percentage in bps (optional).
   * @param newDelaySecs   New governance delay in seconds (optional).
   */
  async proposeParameterUpdate(
    newBurnBps?: number,
    newDelaySecs?: number
  ): Promise<TransactionSignature> {
    return this.program.methods
      .proposeParameterUpdate(
        newBurnBps ?? null,
        newDelaySecs ? new BN(newDelaySecs) : null
      )
      .accounts({
        vault: this.vaultPda,
        authority: this.provider.wallet.publicKey,
      })
      .rpc();
  }

  /**
   * Execute a pending parameter update after the timelock has expired.
   */
  async executeParameterUpdate(): Promise<TransactionSignature> {
    return this.program.methods
      .executeParameterUpdate()
      .accounts({
        vault: this.vaultPda,
        authority: this.provider.wallet.publicKey,
      })
      .rpc();
  }

  /**
   * Cancel a pending parameter proposal.
   */
  async cancelParameterProposal(): Promise<TransactionSignature> {
    return this.program.methods
      .cancelParameterProposal()
      .accounts({
        vault: this.vaultPda,
        authority: this.provider.wallet.publicKey,
      })
      .rpc();
  }

  // -----------------------------------------------------------------------
  // Queries
  // -----------------------------------------------------------------------

  /**
   * Fetch the current on-chain vault state.
   *
   * @returns The deserialized `VaultState`, or `null` if not yet initialized.
   */
  async getVaultState(): Promise<VaultState | null> {
    try {
      const raw = await this.program.account.vault.fetch(this.vaultPda);
      return raw as unknown as VaultState;
    } catch {
      // Account does not exist yet
      return null;
    }
  }
}

export default SolForgeClient;
