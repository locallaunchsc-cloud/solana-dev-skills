// tests/hello-program.ts
//
// Anchor's default test harness uses ts-mocha + chai. After `anchor init`,
// drop this file in `tests/` and run `anchor test`. The framework will:
//   1. spin up solana-test-validator
//   2. deploy target/deploy/hello_program.so
//   3. wire up the IDL on `anchor.workspace.HelloProgram`
//   4. run this file, then shut the validator down.
//
// Adjust the workspace key if you renamed your program (camelCase of the
// program name in Cargo.toml / Anchor.toml).

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";
import { HelloProgram } from "../target/types/hello_program";

describe("hello-program", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.HelloProgram as Program<HelloProgram>;
  const counter = Keypair.generate();

  it("initializes the counter to 0", async () => {
    await program.methods
      .initialize()
      .accounts({
        counter: counter.publicKey,
        payer: provider.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([counter])
      .rpc();

    const account = await program.account.counter.fetch(counter.publicKey);
    assert.strictEqual(account.count.toNumber(), 0);
    assert.ok(account.authority.equals(provider.wallet.publicKey));
  });

  it("increments the counter", async () => {
    await program.methods
      .increment()
      .accounts({
        counter: counter.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.counter.fetch(counter.publicKey);
    assert.strictEqual(account.count.toNumber(), 1);
  });

  it("increments again", async () => {
    await program.methods
      .increment()
      .accounts({
        counter: counter.publicKey,
        authority: provider.wallet.publicKey,
      })
      .rpc();

    const account = await program.account.counter.fetch(counter.publicKey);
    assert.strictEqual(account.count.toNumber(), 2);
  });

  it("rejects increment from a non-authority signer", async () => {
    const stranger = Keypair.generate();
    try {
      await program.methods
        .increment()
        .accounts({
          counter: counter.publicKey,
          authority: stranger.publicKey,
        })
        .signers([stranger])
        .rpc();
      assert.fail("expected has_one constraint to reject this call");
    } catch (err: any) {
      // Anchor surfaces the constraint failure as an AnchorError.
      assert.match(err.toString(), /has_one|ConstraintHasOne|2001/);
    }
  });
});
