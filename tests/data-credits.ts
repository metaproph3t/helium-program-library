import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import {
  getAccount, getAssociatedTokenAddress
} from "@solana/spl-token";
import * as web3 from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { assert, expect } from "chai";
import { accountPayerKey, burnDataCreditsInstructions, init, mintDataCreditsInstructions } from "../packages/data-credits-sdk/src";
import { PROGRAM_ID } from "../packages/data-credits-sdk/src/constants";
import * as hsd from "../packages/helium-sub-daos-sdk/src";
import { execute, toBN, toNumber } from "../packages/spl-utils/src";
import { DataCredits } from "../target/types/data_credits";
import { HeliumSubDaos } from "../target/types/helium_sub_daos";
import { initTestSubdao } from "./utils/daos";
import { createAtaAndMint, createMint, createTestNft } from "./utils/token";

const EPOCH_REWARDS = 100000000;

describe("data-credits", () => {
  anchor.setProvider(anchor.AnchorProvider.local("http://127.0.0.1:8899"));

  let program: Program<DataCredits>;
  let hsdProgram: Program<HeliumSubDaos>;
  let dcKey: PublicKey;
  let hntMint: PublicKey;
  let dcMint: PublicKey;
  let startHntBal = 10000;
  let startDcBal = 1;
  let hntDecimals = 8;
  let dcDecimals = 8;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const me = provider.wallet.publicKey;

  beforeEach(async () => {
    program = await init(
      provider,
      PROGRAM_ID,
      anchor.workspace.DataCredits.idl
    );
    hsdProgram = await hsd.init(
      provider,
      hsd.PROGRAM_ID,
      anchor.workspace.HeliumSubDaos.idl
    );
    // fresh start
    hntMint = await createMint(provider, hntDecimals, me, me);
    dcMint = await createMint(provider, dcDecimals, me, me);
    await createAtaAndMint(
      provider,
      hntMint,
      toBN(startHntBal, hntDecimals).toNumber(),
      me
    );
    await createAtaAndMint(
      provider,
      dcMint,
      toBN(startDcBal, dcDecimals).toNumber(),
      me
    );
    const method = await program.methods
      .initializeDataCreditsV0({ authority: me })
      .accounts({ hntMint, dcMint, payer: me });
    dcKey = (await method.pubkeys()).dataCredits!;
    await method.rpc({
      skipPreflight: true
    });
  });

  it("initializes data credits", async () => {
    const dataCreditsAcc = await program.account.dataCreditsV0.fetch(dcKey);
    assert(dataCreditsAcc?.dcMint.equals(dcMint));
    assert(dataCreditsAcc?.hntMint.equals(hntMint));
    assert(dataCreditsAcc?.authority.equals(me));
  });

  describe("with data credits", async () => {
    let dao: PublicKey;
    let subDao: PublicKey;

    beforeEach(async () => {
      const method = await hsdProgram.methods
        .initializeDaoV0({
          authority: me,
          rewardPerEpoch: new BN(EPOCH_REWARDS),
        })
        .accounts({
          mint: hntMint,
        });
      dao = (await method.pubkeys()).dao!;
      if (!(await provider.connection.getAccountInfo(dao))) {
        await method.rpc();
      }

      const collection = (await createTestNft(provider, me)).mintKey;
      ({ subDao } = await initTestSubdao(hsdProgram, provider, me, dao, collection));
    });
    it("mints some data credits", async () => {
      const ix = await mintDataCreditsInstructions({
        program,
        provider,
        dcMint,
        amount: 1,
      });
      await execute(program, provider, ix);

      const dcAta = await getAssociatedTokenAddress(dcMint, me);
      const dcAtaAcc = await getAccount(provider.connection, dcAta);

      assert(dcAtaAcc.isFrozen);
      const dcBal = await provider.connection.getTokenAccountBalance(dcAta);
      const hntBal = await provider.connection.getTokenAccountBalance(
        await getAssociatedTokenAddress(hntMint, me)
      );
      expect(dcBal.value.uiAmount).to.eq(startDcBal + 1);
      expect(hntBal.value.uiAmount).to.eq(startHntBal - 1);
    });

    it("burns some data credits", async () => {
      await provider.connection.requestAirdrop(
        accountPayerKey()[0],
        web3.LAMPORTS_PER_SOL
      );
      const ix = await burnDataCreditsInstructions({
        program,
        provider,
        dcMint,
        amount: 1,
        subDao,
      });
      await execute(program, provider, ix);

      const dcAta = await getAssociatedTokenAddress(dcMint, me);
      const dcAtaAcc = await getAccount(provider.connection, dcAta);

      assert(dcAtaAcc.isFrozen);
      const dcBal = await provider.connection.getTokenAccountBalance(dcAta);
      expect(dcBal.value.uiAmount).to.eq(startDcBal - 1);

      // check that epoch info was tracked correctly
      const epochInfo = await hsdProgram.account.subDaoEpochInfoV0.fetch(
        ix.output.subDaoEpochInfo
      );
      const numBurned = toNumber(epochInfo.dcBurned as BN, dcDecimals);
      expect(numBurned).to.eq(1);
    });
  });
});