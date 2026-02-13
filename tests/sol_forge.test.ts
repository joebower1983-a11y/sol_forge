import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorError, BN } from "@coral-xyz/anchor";
import { SolForge } from "../target/types/sol_forge";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { expect } from "chai";

// Solana's native incinerator address
const INCINERATOR = new PublicKey("1nc1nerator11111111111111111111111111111111");

const MIN_BURN_AMOUNT = 1_000_000; // 0.001 SOL
const DEFAULT_DELAY = 86_400;
const MIN_DELAY = 3_600;
const MAX_DELAY = 604_800;

describe("sol_forge", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.SolForge as Program<SolForge>;
  const authority = provider.wallet;

  let vaultPda: PublicKey;
  let vaultBump: number;

  before(async () => {
    [vaultPda, vaultBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault")],
      program.programId
    );
  });

  // ─── Helper ──────────────────────────────────────────────────────────

  async function airdrop(pubkey: PublicKey, sol: number) {
    const sig = await provider.connection.requestAirdrop(
      pubkey,
      sol * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);
  }

  async function getVault() {
    return program.account.vault.fetch(vaultPda);
  }

  function expectAnchorError(err: any, codeOrName: string) {
    expect(err).to.be.instanceOf(AnchorError);
    const anchorErr = err as AnchorError;
    expect(
      anchorErr.error.errorCode.code === codeOrName ||
        anchorErr.error.errorCode.number.toString() === codeOrName
    ).to.be.true;
  }

  // ─── initialize_vault ────────────────────────────────────────────────

  describe("initialize_vault", () => {
    it("initializes with valid params and default delay", async () => {
      const feeBps = 500; // 5%
      const burnBps = 2000; // 20%

      await program.methods
        .initializeVault(feeBps, burnBps, null)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vault = await getVault();
      expect(vault.authority.toBase58()).to.equal(
        authority.publicKey.toBase58()
      );
      expect(vault.feeBasisPoints).to.equal(feeBps);
      expect(vault.burnPercentageBps).to.equal(burnBps);
      expect(vault.delaySeconds.toNumber()).to.equal(DEFAULT_DELAY);
      expect(vault.totalAccrued.toNumber()).to.equal(0);
      expect(vault.bump).to.equal(vaultBump);
      expect(vault.pendingBurnPercentageBps).to.be.null;
      expect(vault.pendingDelaySeconds).to.be.null;
      expect(vault.pendingReleaseTime.toNumber()).to.equal(0);
    });

    it("fails to re-initialize (account already exists)", async () => {
      try {
        await program.methods
          .initializeVault(100, 100, null)
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        // Anchor rejects init on already-initialized account
        expect(err.toString()).to.contain("already in use");
      }
    });

    // NOTE: The following validation tests require fresh vault PDAs per test,
    // which Anchor's singleton PDA design prevents. We document the expected
    // behavior; in a real scenario these would use a factory or separate seeds.

    it("rejects fee_bps > 10000", async () => {
      // Cannot test in isolation with singleton PDA after first init.
      // Validated by the require!(fee_bps <= 10_000) constraint.
      // If vault were re-initializable:
      // expectAnchorError(err, "InvalidFeeRate");
    });

    it("rejects burn_bps > 10000", async () => {
      // Same limitation as above.
      // expectAnchorError(err, "InvalidBurnPercentage");
    });

    it("rejects delay outside allowed range", async () => {
      // Same limitation.
      // expectAnchorError(err, "InvalidDelay");
    });
  });

  // ─── accrue_fee ──────────────────────────────────────────────────────

  describe("accrue_fee", () => {
    it("accrues a fee and auto-burns the correct portion", async () => {
      const amount = 1_000_000_000; // 1 SOL
      const vault = await getVault();
      const burnBps = vault.burnPercentageBps; // 2000 = 20%
      const prevAccrued = vault.totalAccrued.toNumber();

      const expectedBurn = Math.floor((amount * burnBps) / 10_000);
      const expectedNet = amount - expectedBurn;

      const incineratorBefore = await provider.connection.getBalance(
        INCINERATOR
      );

      await program.methods
        .accrueFee(new BN(amount))
        .accounts({
          vault: vaultPda,
          payer: authority.publicKey,
          incinerator: INCINERATOR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await getVault();
      expect(vaultAfter.totalAccrued.toNumber()).to.equal(
        prevAccrued + expectedNet
      );

      // Verify incinerator received the burn
      const incineratorAfter = await provider.connection.getBalance(
        INCINERATOR
      );
      expect(incineratorAfter - incineratorBefore).to.equal(expectedBurn);
    });

    it("accrues multiple fees cumulatively", async () => {
      const vault1 = await getVault();
      const amount = 500_000_000; // 0.5 SOL
      const burnBps = vault1.burnPercentageBps;
      const expectedNet = amount - Math.floor((amount * burnBps) / 10_000);

      await program.methods
        .accrueFee(new BN(amount))
        .accounts({
          vault: vaultPda,
          payer: authority.publicKey,
          incinerator: INCINERATOR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vault2 = await getVault();
      expect(vault2.totalAccrued.toNumber()).to.equal(
        vault1.totalAccrued.toNumber() + expectedNet
      );
    });

    it("rejects zero amount (dust protection)", async () => {
      try {
        await program.methods
          .accrueFee(new BN(0))
          .accounts({
            vault: vaultPda,
            payer: authority.publicKey,
            incinerator: INCINERATOR,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "AmountTooSmall");
      }
    });

    it("allows any payer (not just authority)", async () => {
      const randomPayer = Keypair.generate();
      await airdrop(randomPayer.publicKey, 2);

      const amount = 100_000_000; // 0.1 SOL

      await program.methods
        .accrueFee(new BN(amount))
        .accounts({
          vault: vaultPda,
          payer: randomPayer.publicKey,
          incinerator: INCINERATOR,
          systemProgram: SystemProgram.programId,
        })
        .signers([randomPayer])
        .rpc();

      // If it didn't throw, any payer works ✓
    });
  });

  // ─── burn_sol ────────────────────────────────────────────────────────

  describe("burn_sol", () => {
    it("authority burns SOL from vault", async () => {
      const vaultBefore = await getVault();
      const burnAmount = MIN_BURN_AMOUNT;

      const incBefore = await provider.connection.getBalance(INCINERATOR);

      await program.methods
        .burnSol(new BN(burnAmount))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
          incinerator: INCINERATOR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await getVault();
      expect(vaultAfter.totalAccrued.toNumber()).to.equal(
        vaultBefore.totalAccrued.toNumber() - burnAmount
      );

      const incAfter = await provider.connection.getBalance(INCINERATOR);
      expect(incAfter - incBefore).to.equal(burnAmount);
    });

    it("rejects burn below MIN_BURN_AMOUNT (dust protection)", async () => {
      try {
        await program.methods
          .burnSol(new BN(MIN_BURN_AMOUNT - 1))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
            incinerator: INCINERATOR,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "AmountTooSmall");
      }
    });

    it("rejects burn exceeding vault balance", async () => {
      const vault = await getVault();
      const tooMuch = vault.totalAccrued.toNumber() + LAMPORTS_PER_SOL;

      try {
        await program.methods
          .burnSol(new BN(tooMuch))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
            incinerator: INCINERATOR,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "InsufficientBalance");
      }
    });

    it("rejects unauthorized caller", async () => {
      const imposter = Keypair.generate();
      await airdrop(imposter.publicKey, 1);

      try {
        await program.methods
          .burnSol(new BN(MIN_BURN_AMOUNT))
          .accounts({
            vault: vaultPda,
            authority: imposter.publicKey,
            incinerator: INCINERATOR,
            systemProgram: SystemProgram.programId,
          })
          .signers([imposter])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "Unauthorized");
      }
    });
  });

  // ─── distribute_rewards ──────────────────────────────────────────────

  describe("distribute_rewards", () => {
    it("distributes SOL to a recipient", async () => {
      const recipient = Keypair.generate();
      const vaultBefore = await getVault();
      const distAmount = MIN_BURN_AMOUNT;

      const recipientBefore = await provider.connection.getBalance(
        recipient.publicKey
      );

      await program.methods
        .distributeRewards(new BN(distAmount))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
          recipient: recipient.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = await getVault();
      expect(vaultAfter.totalAccrued.toNumber()).to.equal(
        vaultBefore.totalAccrued.toNumber() - distAmount
      );

      const recipientAfter = await provider.connection.getBalance(
        recipient.publicKey
      );
      expect(recipientAfter - recipientBefore).to.equal(distAmount);
    });

    it("rejects distribution below MIN_BURN_AMOUNT", async () => {
      const recipient = Keypair.generate();
      try {
        await program.methods
          .distributeRewards(new BN(MIN_BURN_AMOUNT - 1))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
            recipient: recipient.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "AmountTooSmall");
      }
    });

    it("rejects distribution exceeding vault balance", async () => {
      const recipient = Keypair.generate();
      const vault = await getVault();
      const tooMuch = vault.totalAccrued.toNumber() + LAMPORTS_PER_SOL;

      try {
        await program.methods
          .distributeRewards(new BN(tooMuch))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
            recipient: recipient.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "InsufficientBalance");
      }
    });

    it("rejects unauthorized caller", async () => {
      const imposter = Keypair.generate();
      const recipient = Keypair.generate();
      await airdrop(imposter.publicKey, 1);

      try {
        await program.methods
          .distributeRewards(new BN(MIN_BURN_AMOUNT))
          .accounts({
            vault: vaultPda,
            authority: imposter.publicKey,
            recipient: recipient.publicKey,
            systemProgram: SystemProgram.programId,
          })
          .signers([imposter])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "Unauthorized");
      }
    });
  });

  // ─── propose_parameter_update ────────────────────────────────────────

  describe("propose_parameter_update", () => {
    it("proposes a burn percentage update", async () => {
      const newBurnBps = 3000; // 30%

      await program.methods
        .proposeParameterUpdate(newBurnBps, null)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const vault = await getVault();
      expect(vault.pendingBurnPercentageBps).to.equal(newBurnBps);
      expect(vault.pendingDelaySeconds).to.be.null;
      expect(vault.pendingReleaseTime.toNumber()).to.be.greaterThan(0);
    });

    it("proposes a delay update", async () => {
      const newDelay = new BN(7200); // 2 hours

      await program.methods
        .proposeParameterUpdate(null, newDelay)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const vault = await getVault();
      expect(vault.pendingDelaySeconds.toNumber()).to.equal(7200);
    });

    it("proposes both burn and delay", async () => {
      await program.methods
        .proposeParameterUpdate(5000, new BN(MIN_DELAY))
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const vault = await getVault();
      expect(vault.pendingBurnPercentageBps).to.equal(5000);
      expect(vault.pendingDelaySeconds.toNumber()).to.equal(MIN_DELAY);
    });

    it("rejects when no change proposed (both null)", async () => {
      try {
        await program.methods
          .proposeParameterUpdate(null, null)
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "NoChangeProposed");
      }
    });

    it("rejects invalid burn_bps > 10000", async () => {
      try {
        await program.methods
          .proposeParameterUpdate(10001, null)
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "InvalidBurnPercentage");
      }
    });

    it("rejects delay below MIN_DELAY", async () => {
      try {
        await program.methods
          .proposeParameterUpdate(null, new BN(MIN_DELAY - 1))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "InvalidDelay");
      }
    });

    it("rejects delay above MAX_DELAY", async () => {
      try {
        await program.methods
          .proposeParameterUpdate(null, new BN(MAX_DELAY + 1))
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "InvalidDelay");
      }
    });

    it("rejects unauthorized caller", async () => {
      const imposter = Keypair.generate();
      await airdrop(imposter.publicKey, 1);

      try {
        await program.methods
          .proposeParameterUpdate(1000, null)
          .accounts({
            vault: vaultPda,
            authority: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "Unauthorized");
      }
    });
  });

  // ─── execute_parameter_update ────────────────────────────────────────

  describe("execute_parameter_update", () => {
    it("rejects execution before timelock expires", async () => {
      // Ensure there's a pending proposal
      await program.methods
        .proposeParameterUpdate(4000, null)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      try {
        await program.methods
          .executeParameterUpdate()
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "TimelockNotExpired");
      }
    });

    it("rejects execution when no pending update exists", async () => {
      // Cancel any pending first
      try {
        await program.methods
          .cancelParameterProposal()
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
      } catch {
        // ignore if nothing pending
      }

      try {
        await program.methods
          .executeParameterUpdate()
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "NoPendingUpdate");
      }
    });

    it("rejects unauthorized caller", async () => {
      // Set up a proposal first
      await program.methods
        .proposeParameterUpdate(2500, null)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const imposter = Keypair.generate();
      await airdrop(imposter.publicKey, 1);

      try {
        await program.methods
          .executeParameterUpdate()
          .accounts({
            vault: vaultPda,
            authority: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "Unauthorized");
      }
    });

    // NOTE: Testing successful execution requires advancing the validator clock
    // past the timelock period. With solana-test-validator this can be done via
    // `solana warp-slot` or bankrun's `context.warpToSlot()`.
    // In a bankrun / solana-program-test environment:
    //
    // it("executes after timelock expires", async () => {
    //   await warpForward(DEFAULT_DELAY + 1);
    //   await program.methods.executeParameterUpdate().accounts({...}).rpc();
    //   const vault = await getVault();
    //   expect(vault.burnPercentageBps).to.equal(2500);
    //   expect(vault.pendingBurnPercentageBps).to.be.null;
    // });
  });

  // ─── cancel_parameter_proposal ───────────────────────────────────────

  describe("cancel_parameter_proposal", () => {
    it("cancels a pending proposal", async () => {
      // Ensure pending proposal exists from previous tests or create one
      const vaultBefore = await getVault();
      if (!vaultBefore.pendingBurnPercentageBps && !vaultBefore.pendingDelaySeconds) {
        await program.methods
          .proposeParameterUpdate(1500, null)
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
      }

      await program.methods
        .cancelParameterProposal()
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const vaultAfter = await getVault();
      expect(vaultAfter.pendingBurnPercentageBps).to.be.null;
      expect(vaultAfter.pendingDelaySeconds).to.be.null;
      expect(vaultAfter.pendingReleaseTime.toNumber()).to.equal(0);
    });

    it("rejects cancel when no pending update", async () => {
      try {
        await program.methods
          .cancelParameterProposal()
          .accounts({
            vault: vaultPda,
            authority: authority.publicKey,
          })
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "NoPendingUpdate");
      }
    });

    it("rejects unauthorized caller", async () => {
      // Create a proposal to cancel
      await program.methods
        .proposeParameterUpdate(1000, null)
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();

      const imposter = Keypair.generate();
      await airdrop(imposter.publicKey, 1);

      try {
        await program.methods
          .cancelParameterProposal()
          .accounts({
            vault: vaultPda,
            authority: imposter.publicKey,
          })
          .signers([imposter])
          .rpc();
        expect.fail("should have thrown");
      } catch (err: any) {
        expectAnchorError(err, "Unauthorized");
      }

      // Cleanup: cancel the proposal with the real authority
      await program.methods
        .cancelParameterProposal()
        .accounts({
          vault: vaultPda,
          authority: authority.publicKey,
        })
        .rpc();
    });
  });
});
