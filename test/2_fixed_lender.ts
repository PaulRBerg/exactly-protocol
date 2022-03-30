import { expect } from "chai";
import { ethers, deployments } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import type { BigNumber, ContractTransaction } from "ethers";
import type { Auditor, ETHFixedLender, FixedLender, InterestRateModel, MockToken, PoolAccounting } from "../types";
import timelockExecute from "./utils/timelockExecute";
import futurePools from "./utils/futurePools";
import { decodeMaturities } from "./exactlyUtils";

const {
  utils: { parseUnits },
  getUnnamedSigners,
  getNamedSigner,
  getContract,
  provider,
} = ethers;

describe("FixedLender", function () {
  let dai: MockToken;
  let auditor: Auditor;
  let fixedLenderDAI: FixedLender;
  let fixedLenderWETH: ETHFixedLender;
  let poolAccountingDAI: PoolAccounting;
  let interestRateModel: InterestRateModel;

  let maria: SignerWithAddress;
  let john: SignerWithAddress;
  let owner: SignerWithAddress;
  let penaltyRate: BigNumber;

  before(async () => {
    owner = await getNamedSigner("multisig");
    [maria, john] = await getUnnamedSigners();
  });

  beforeEach(async () => {
    await deployments.fixture(["Markets"]);

    dai = await getContract<MockToken>("DAI", maria);
    auditor = await getContract<Auditor>("Auditor", maria);
    fixedLenderDAI = await getContract<FixedLender>("FixedLenderDAI", maria);
    fixedLenderWETH = await getContract<ETHFixedLender>("FixedLenderWETH", maria);
    poolAccountingDAI = await getContract<PoolAccounting>("PoolAccountingDAI", maria);
    interestRateModel = await getContract<InterestRateModel>("InterestRateModel", owner);
    penaltyRate = await poolAccountingDAI.penaltyRate();

    await timelockExecute(owner, interestRateModel, "setCurveParameters", [0, 0, parseUnits("10"), parseUnits("1")]);
    await timelockExecute(owner, interestRateModel, "setSPFeeRate", [0]);
    for (const signer of [maria, john]) {
      await dai.connect(owner).transfer(signer.address, parseUnits("10000"));
      await dai.connect(signer).approve(fixedLenderDAI.address, parseUnits("10000"));
    }
  });

  describe("small positions", () => {
    describe("WHEN depositing 2wei of a dai", () => {
      beforeEach(async () => {
        await fixedLenderDAI.deposit(2, maria.address);
        // we add liquidity to the maturity
        await fixedLenderDAI.depositToMaturityPool(2, futurePools(1)[0], 0);
      });
      it("THEN the FixedLender registers a supply of 2 wei DAI for the user (exposed via getAccountSnapshot)", async () => {
        expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[0]).to.equal(2);
      });
      it("AND the Market Size of the smart pool is 2 wei of a dai", async () => {
        expect(await fixedLenderDAI.totalAssets()).to.equal(2);
      });
      it("AND its not possible to borrow 2 wei of a dai", async () => {
        await expect(fixedLenderDAI.borrowFromMaturityPool(2, futurePools(1)[0], 2)).to.be.revertedWith(
          "InsufficientLiquidity()",
        );
      });
      describe("AND WHEN borrowing 1 wei of DAI", () => {
        let tx: ContractTransaction;
        beforeEach(async () => {
          tx = await fixedLenderDAI.borrowFromMaturityPool(1, futurePools(1)[0], 1);
        });
        it("THEN a BorrowFromMaturityPool event is emitted", async () => {
          await expect(tx)
            .to.emit(fixedLenderDAI, "BorrowFromMaturityPool")
            .withArgs(maria.address, 1, 0, futurePools(1)[0]);
        });
        it("AND the Market Size of the smart pool remains in 2 wei of a dai", async () => {
          expect(await fixedLenderDAI.totalAssets()).to.be.equal(2);
        });
        it("AND a 1 wei of DAI borrow is registered", async () => {
          expect(await fixedLenderDAI.getTotalMpBorrows(futurePools(1)[0])).to.equal(1);
        });
      });
    });
  });

  describe("WHEN depositing 100 DAI to a maturity pool", () => {
    let tx: ContractTransaction;
    beforeEach(async () => {
      tx = await fixedLenderDAI.depositToMaturityPool(parseUnits("100"), futurePools(1)[0], parseUnits("100"));
    });
    it("THEN a DepositToMaturityPool event is emitted", async () => {
      await expect(tx)
        .to.emit(fixedLenderDAI, "DepositToMaturityPool")
        .withArgs(maria.address, parseUnits("100"), 0, futurePools(1)[0]);
    });
    it("AND the FixedLender contract has a balance of 100 DAI", async () => {
      expect(await dai.balanceOf(fixedLenderDAI.address)).to.equal(parseUnits("100"));
    });
    it("AND the FixedLender registers a supply of 100 DAI for the user", async () => {
      expect((await poolAccountingDAI.mpUserSuppliedAmount(futurePools(1)[0], maria.address))[0]).to.equal(
        parseUnits("100"),
      );
    });
    it("WHEN trying to borrow DAI THEN it reverts with INSUFFICIENT_LIQUIDITY since collateral was not deposited yet", async () => {
      await expect(fixedLenderDAI.borrowFromMaturityPool(1000, futurePools(1)[0], 2000)).to.be.revertedWith(
        "InsufficientLiquidity()",
      );
    });
    describe("AND WHEN depositing 50 DAI to the same maturity, as the same user", () => {
      beforeEach(async () => {
        tx = await fixedLenderDAI.depositToMaturityPool(parseUnits("50"), futurePools(1)[0], parseUnits("50"));
      });
      it("THEN a DepositToMaturityPool event is emitted", async () => {
        await expect(tx)
          .to.emit(fixedLenderDAI, "DepositToMaturityPool")
          .withArgs(maria.address, parseUnits("50"), 0, futurePools(1)[0]);
      });
      it("AND the FixedLender contract has a balance of 150 DAI", async () => {
        expect(await dai.balanceOf(fixedLenderDAI.address)).to.equal(parseUnits("150"));
      });
      it("AND the FixedLender does not register a smart pool balance deposit (exposed via getAccountSnapshot)", async () => {
        expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[0]).to.equal(0);
      });
    });

    describe("WHEN depositing collateral and borrowing 60 DAI from the same maturity", () => {
      beforeEach(async () => {
        await fixedLenderDAI.deposit(parseUnits("100"), maria.address);
        tx = await fixedLenderDAI.borrowFromMaturityPool(parseUnits("60"), futurePools(1)[0], parseUnits("66"));
      });
      it("THEN a BorrowFromMaturityPool event is emitted", async () => {
        await expect(tx)
          .to.emit(fixedLenderDAI, "BorrowFromMaturityPool")
          .withArgs(maria.address, parseUnits("60"), 0, futurePools(1)[0]);
      });
      it("AND a 60 DAI borrow is registered", async () => {
        expect(await fixedLenderDAI.getTotalMpBorrows(futurePools(1)[0])).to.equal(parseUnits("60"));
      });
      it("AND contract's state variable userMpBorrowed registers the maturity where the user borrowed from", async () => {
        const maturities = await poolAccountingDAI.userMpBorrowed(maria.address);
        expect(decodeMaturities(maturities)).contains(futurePools(1)[0].toNumber());
      });
      describe("AND WHEN trying to repay 100 (too much)", () => {
        let balanceBefore: BigNumber;

        beforeEach(async () => {
          balanceBefore = await dai.balanceOf(maria.address);
          await fixedLenderDAI.repayToMaturityPool(
            maria.address,
            futurePools(1)[0],
            parseUnits("100"),
            parseUnits("100"),
          );
        });
        it("THEN all debt is repaid", async () => {
          expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(0);
        });
        it("THEN the 40 spare amount is not discounted from the user balance", async () => {
          expect(await dai.balanceOf(maria.address)).to.equal(balanceBefore.sub(parseUnits("60")));
        });
      });
      describe("AND WHEN borrowing 60 DAI from another maturity AND repaying only first debt", () => {
        beforeEach(async () => {
          await fixedLenderDAI.deposit(parseUnits("1000"), maria.address);
          await fixedLenderDAI.borrowFromMaturityPool(parseUnits("60"), futurePools(2)[1], parseUnits("60"));
          await fixedLenderDAI.repayToMaturityPool(
            maria.address,
            futurePools(1)[0],
            parseUnits("60"),
            parseUnits("60"),
          );
        });
        it("THEN contract's state variable userMpBorrowed registers the second maturity where the user borrowed from", async () => {
          const maturities = await poolAccountingDAI.userMpBorrowed(maria.address);
          expect(decodeMaturities(maturities)).contains(futurePools(2)[1].toNumber());
        });
      });
      describe("AND WHEN fully repaying the debt", () => {
        beforeEach(async () => {
          tx = await fixedLenderDAI.repayToMaturityPool(
            maria.address,
            futurePools(1)[0],
            parseUnits("60"),
            parseUnits("60"),
          );
        });
        it("THEN a RepayToMaturityPool event is emitted", async () => {
          await expect(tx)
            .to.emit(fixedLenderDAI, "RepayToMaturityPool")
            .withArgs(maria.address, maria.address, parseUnits("60"), parseUnits("60"), futurePools(1)[0]);
        });
        it("AND contract's state variable userMpBorrowed does not register the maturity where the user borrowed from anymore", async () => {
          const maturities = await poolAccountingDAI.userMpBorrowed(maria.address);
          expect(decodeMaturities(maturities).length).eq(0);
        });
        describe("AND WHEN withdrawing collateral and maturity pool deposit", () => {
          beforeEach(async () => {
            await fixedLenderDAI.withdraw(parseUnits("100"), maria.address, maria.address);
            await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 1]);
            await fixedLenderDAI.withdrawFromMaturityPool(parseUnits("100"), parseUnits("100"), futurePools(1)[0]);
          });
          it("THEN the collateral & deposits are returned to Maria (10000)", async () => {
            expect(await dai.balanceOf(maria.address)).to.equal(parseUnits("10000"));
            expect(await dai.balanceOf(fixedLenderDAI.address)).to.equal(0);
          });
        });

        describe("AND WHEN withdrawing MORE from maturity pool than maria has", () => {
          beforeEach(async () => {
            await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 1]);
            await fixedLenderDAI.withdrawFromMaturityPool(parseUnits("1000000"), parseUnits("100"), futurePools(1)[0]);
          });
          it("THEN the total amount withdrawn is 9900 (the max)", async () => {
            expect(await dai.balanceOf(maria.address)).to.equal(parseUnits("9900"));
          });
        });

        describe("AND WHEN withdrawing LESS from maturity pool than maria has", () => {
          beforeEach(async () => {
            await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 1]);
            await fixedLenderDAI.withdrawFromMaturityPool(parseUnits("50"), parseUnits("50"), futurePools(1)[0]);
          });
          it("THEN the total amount withdrawn is 9950 (leaving 150 in FixedLender / 100 in SP / 50 in MP)", async () => {
            expect(await dai.balanceOf(maria.address)).to.equal(parseUnits("9850"));
            expect(await dai.balanceOf(fixedLenderDAI.address)).to.equal(parseUnits("150"));
          });
        });
      });
      describe("GIVEN the maturity pool matures", () => {
        beforeEach(async () => {
          await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 1]);
        });
        it("WHEN trying to withdraw an amount of zero THEN it reverts", async () => {
          await expect(fixedLenderDAI.withdrawFromMaturityPool(0, 0, futurePools(1)[0])).to.be.revertedWith(
            "ZeroRedeem()",
          );
        });
      });

      describe("AND WHEN partially (40DAI, 66%) repaying the debt", () => {
        beforeEach(async () => {
          tx = await fixedLenderDAI.repayToMaturityPool(
            maria.address,
            futurePools(1)[0],
            parseUnits("40"),
            parseUnits("40"),
          );
        });
        it("THEN a RepayToMaturityPool event is emitted", async () => {
          await expect(tx)
            .to.emit(fixedLenderDAI, "RepayToMaturityPool")
            .withArgs(maria.address, maria.address, parseUnits("40"), parseUnits("40"), futurePools(1)[0]);
        });
        it("AND Maria still owes 20 DAI", async () => {
          expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(
            parseUnits("20"),
          );
        });

        describe("AND WHEN moving in time to 1 day after maturity", () => {
          let penalty: BigNumber;
          beforeEach(async () => {
            await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 86_400]);
            penalty = parseUnits("20").mul(penaltyRate).div(parseUnits("1")).mul(86_400);
            expect(penalty).to.be.gt(0);
          });
          it("THEN Maria owes (getAccountSnapshot) 20 DAI of principal + (20*0.02 ~= 0.0400032 ) DAI of late payment penalties", async () => {
            await provider.send("evm_mine", []);
            expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(
              parseUnits("20").add(penalty),
            );
          });
          describe("AND WHEN repaying the rest of the 20.4 owed DAI", () => {
            beforeEach(async () => {
              const amount = parseUnits("20").add(penalty);
              await fixedLenderDAI.repayToMaturityPool(maria.address, futurePools(1)[0], amount, amount);
            });
            it("THEN all debt is repaid", async () => {
              expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(0);
            });
          });
          describe("AND WHEN repaying more than what is owed (30 DAI)", () => {
            beforeEach(async () => {
              await fixedLenderDAI.repayToMaturityPool(
                maria.address,
                futurePools(1)[0],
                parseUnits("30"),
                parseUnits("30"),
              );
            });
            it("THEN all debt is repaid", async () => {
              expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(0);
            });
          });
        });
      });
    });

    describe("AND WHEN moving in time to maturity AND withdrawing from the maturity pool", () => {
      beforeEach(async () => {
        await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 1]);
        tx = await fixedLenderDAI.withdrawFromMaturityPool(parseUnits("100"), parseUnits("100"), futurePools(1)[0]);
      });
      it("THEN 100 DAI are returned to Maria", async () => {
        expect(await dai.balanceOf(maria.address)).to.equal(parseUnits("10000"));
        expect(await dai.balanceOf(fixedLenderDAI.address)).to.equal(0);
      });
      it("AND a WithdrawFromMaturityPool event is emitted", async () => {
        await expect(tx)
          .to.emit(fixedLenderDAI, "WithdrawFromMaturityPool")
          .withArgs(maria.address, parseUnits("100"), parseUnits("100"), futurePools(1)[0]);
      });
    });
  });

  describe("simple validations:", () => {
    it("WHEN calling setMaxFuturePools from a regular (non-admin) user, THEN it reverts with an AccessControl error", async () => {
      await expect(fixedLenderDAI.setMaxFuturePools(12)).to.be.revertedWith("AccessControl");
    });
  });

  describe("GIVEN an interest rate of 2%", () => {
    beforeEach(async () => {
      await timelockExecute(owner, interestRateModel, "setCurveParameters", [
        0,
        parseUnits("0.02"),
        parseUnits("10"),
        parseUnits("1"),
      ]);
      await fixedLenderDAI.deposit(parseUnits("1"), maria.address);
      await auditor.enterMarkets([fixedLenderDAI.address]);
      // we add liquidity to the maturity
      await fixedLenderDAI.depositToMaturityPool(parseUnits("1"), futurePools(1)[0], parseUnits("1"));
    });
    it("WHEN trying to borrow 0.8 DAI with a max amount of debt of 0.8 DAI, THEN it reverts with TOO_MUCH_SLIPPAGE", async () => {
      await expect(
        fixedLenderDAI.borrowFromMaturityPool(parseUnits("0.8"), futurePools(1)[0], parseUnits("0.8")),
      ).to.be.revertedWith("TooMuchSlippage()");
    });

    it("WHEN trying to deposit 100 DAI with a minimum required amount to be received of 103, THEN 102 are received instead AND the transaction reverts with TOO_MUCH_SLIPPAGE", async () => {
      await expect(
        fixedLenderDAI.depositToMaturityPool(parseUnits("100"), futurePools(1)[0], parseUnits("103")),
      ).to.be.revertedWith("TooMuchSlippage()");
    });
  });

  describe("GIVEN John deposited 12 DAI to the smart pool AND Maria borrowed 6 DAI from an empty maturity", () => {
    beforeEach(async () => {
      await fixedLenderWETH.depositETH(maria.address, { value: parseUnits("10") });
      await auditor.enterMarkets([fixedLenderWETH.address]);

      await timelockExecute(owner, interestRateModel, "setCurveParameters", [
        parseUnits("0"),
        parseUnits("0"),
        parseUnits("1.1"),
        parseUnits("1"),
      ]);
      await fixedLenderDAI.connect(john).deposit(parseUnits("12"), maria.address);
      await fixedLenderDAI.borrowFromMaturityPool(parseUnits("6"), futurePools(1)[0], parseUnits("6"));
    });
    it("WHEN Maria tries to borrow 5.99 more DAI on the same maturity, THEN it does not revert", async () => {
      await expect(fixedLenderDAI.borrowFromMaturityPool(parseUnits("5.99"), futurePools(1)[0], parseUnits("5.99"))).to
        .not.be.reverted;
    });
    it("WHEN Maria tries to borrow 6 more DAI on the same maturity (remaining liquidity), THEN it does not revert", async () => {
      await expect(fixedLenderDAI.borrowFromMaturityPool(parseUnits("6"), futurePools(1)[0], parseUnits("6"))).to.not.be
        .reverted;
    });
    it("WHEN Maria tries to borrow 6.01 more DAI on another maturity, THEN it fails with InsufficientProtocolLiquidity", async () => {
      await expect(
        fixedLenderDAI.borrowFromMaturityPool(parseUnits("6.01"), futurePools(2)[1], parseUnits("7")),
      ).to.be.revertedWith("InsufficientProtocolLiquidity()");
    });
    it("WHEN Maria tries to borrow 12 more DAI on the same maturity, THEN it fails with UtilizationRateExceeded", async () => {
      await expect(
        fixedLenderDAI.borrowFromMaturityPool(parseUnits("12"), futurePools(1)[0], parseUnits("12")),
      ).to.be.revertedWith("UtilizationRateExceeded()");
    });
    describe("AND John deposited 2388 DAI to the smart pool", () => {
      beforeEach(async () => {
        await fixedLenderDAI.connect(john).deposit(parseUnits("2388"), maria.address);
      });
      it("WHEN Maria tries to borrow 2500 DAI, THEN it fails with UtilizationRateExceeded", async () => {
        await expect(
          fixedLenderDAI.borrowFromMaturityPool(parseUnits("2500"), futurePools(1)[0], parseUnits("5000")),
        ).to.be.revertedWith("UtilizationRateExceeded");
      });
      it("WHEN Maria tries to borrow 150 DAI, THEN it succeeds", async () => {
        await expect(fixedLenderDAI.borrowFromMaturityPool(parseUnits("150"), futurePools(1)[0], parseUnits("150"))).to
          .not.be.reverted;
      });
    });
    describe("AND John deposited 100 DAI to maturity", () => {
      beforeEach(async () => {
        await fixedLenderDAI
          .connect(john)
          .depositToMaturityPool(parseUnits("100"), futurePools(1)[0], parseUnits("100"));
      });
      it("WHEN Maria tries to borrow 150 DAI, THEN it fails with UtilizationRateExceeded", async () => {
        await expect(
          fixedLenderDAI.borrowFromMaturityPool(parseUnits("150"), futurePools(1)[0], parseUnits("150")),
        ).to.be.revertedWith("UtilizationRateExceeded()");
      });
      describe("AND John deposited 1200 DAI to the smart pool", () => {
        beforeEach(async () => {
          await fixedLenderDAI
            .connect(john)
            .depositToMaturityPool(parseUnits("1200"), futurePools(1)[0], parseUnits("1200"));
        });
        it("WHEN Maria tries to borrow 1350 DAI, THEN it fails with UtilizationRateExceeded", async () => {
          await expect(
            fixedLenderDAI.borrowFromMaturityPool(parseUnits("1350"), futurePools(1)[0], parseUnits("2000")),
          ).to.be.revertedWith("UtilizationRateExceeded()");
        });
        it("WHEN Maria tries to borrow 200 DAI, THEN it succeeds", async () => {
          await expect(fixedLenderDAI.borrowFromMaturityPool(parseUnits("200"), futurePools(1)[0], parseUnits("200")))
            .to.not.be.reverted;
        });
        it("WHEN Maria tries to borrow 150 DAI, THEN it succeeds", async () => {
          await expect(fixedLenderDAI.borrowFromMaturityPool(parseUnits("150"), futurePools(1)[0], parseUnits("150")))
            .to.not.be.reverted;
        });
      });
    });
  });

  describe("GIVEN maria has plenty of WETH collateral", () => {
    beforeEach(async () => {
      await fixedLenderWETH.depositETH(maria.address, { value: parseUnits("10") });
      await auditor.enterMarkets([fixedLenderDAI.address, fixedLenderWETH.address]);
    });
    describe("AND GIVEN she deposits 1000DAI into the next two maturity pools AND other 500 into the smart pool", () => {
      beforeEach(async () => {
        for (const pool of futurePools(2)) {
          await fixedLenderDAI.depositToMaturityPool(parseUnits("1000"), pool, parseUnits("1000"));
        }
        await fixedLenderDAI.deposit(parseUnits("6000"), maria.address);
      });
      describe("WHEN borrowing 1200 in the current maturity", () => {
        beforeEach(async () => {
          await fixedLenderDAI.borrowFromMaturityPool(parseUnits("1200"), futurePools(1)[0], parseUnits("1200"));
        });
        it("THEN all of the maturity pools funds are in use", async () => {
          const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
          expect(borrowed).to.gt(supplied);
        });
        it("AND 200 are borrowed from the smart pool", async () => {
          expect(await poolAccountingDAI.smartPoolBorrowed()).to.equal(parseUnits("200"));
          expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).suppliedSP).to.equal(parseUnits("200"));
        });
        it("AND WHEN trying to withdraw 300 ==(500 available, 200 borrowed to MP) from the smart pool, THEN it succeeds", async () => {
          await expect(fixedLenderDAI.withdraw(parseUnits("300"), maria.address, maria.address)).to.not.be.reverted;
        });
        it("AND WHEN trying to withdraw 5900 >(6000 total, 200 borrowed to MP) from the smart pool, THEN it reverts because 100 of those 5900 are still lent to the maturity pool", async () => {
          await expect(fixedLenderDAI.withdraw(parseUnits("5900"), maria.address, maria.address)).to.be.revertedWith(
            "InsufficientProtocolLiquidity()",
          );
        });
        describe("AND borrowing 1100 in a later maturity ", () => {
          beforeEach(async () => {
            await fixedLenderDAI.borrowFromMaturityPool(parseUnits("1100"), futurePools(2)[1], parseUnits("1100"));
          });
          it("THEN all of the maturity pools funds are in use", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(2)[1]);
            expect(borrowed).to.gt(supplied);
          });
          it("THEN the later maturity owes 100 to the smart pool", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(2)[1])).suppliedSP).to.equal(parseUnits("100"));
          });
          it("THEN the smart pool has lent 300 (100 from the later maturity one, 200 from the first one)", async () => {
            expect(await poolAccountingDAI.smartPoolBorrowed()).to.equal(parseUnits("300"));
          });
          describe("AND WHEN repaying 50 DAI in the later maturity", () => {
            beforeEach(async () => {
              await fixedLenderDAI.repayToMaturityPool(
                maria.address,
                futurePools(2)[1],
                parseUnits("50"),
                parseUnits("50"),
              );
            });
            it("THEN 1050 DAI are borrowed", async () => {
              expect((await poolAccountingDAI.maturityPools(futurePools(2)[1])).borrowed).to.equal(parseUnits("1050"));
            });
            it("THEN the maturity pool doesn't have funds available", async () => {
              const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(2)[1]);
              expect(borrowed).to.gt(supplied);
            });
            it("THEN the maturity pool owes 50 to the smart pool", async () => {
              expect((await poolAccountingDAI.maturityPools(futurePools(2)[1])).suppliedSP).to.equal(parseUnits("50"));
            });
            it("THEN the smart pool was repaid 50 DAI (SPborrowed=250)", async () => {
              expect(await poolAccountingDAI.smartPoolBorrowed()).to.equal(parseUnits("250"));
            });
          });
          describe("AND WHEN john deposits 800 to the later maturity", () => {
            beforeEach(async () => {
              await fixedLenderDAI
                .connect(john)
                .depositToMaturityPool(parseUnits("800"), futurePools(2)[1], parseUnits("800"));
            });
            it("THEN 1100 DAI are still borrowed", async () => {
              expect((await poolAccountingDAI.maturityPools(futurePools(2)[1])).borrowed).to.equal(parseUnits("1100"));
            });
            it("THEN the later maturity has 700 DAI available for borrowing", async () => {
              const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(2)[1]);
              expect(supplied.sub(borrowed)).to.equal(parseUnits("700"));
            });
            it("THEN the later maturity has no supply from the Smart Pool", async () => {
              expect((await poolAccountingDAI.maturityPools(futurePools(2)[1])).suppliedSP).to.equal(0);
            });
            it("THEN the smart pool was repaid, and is still owed 200 from the current one", async () => {
              expect(await poolAccountingDAI.smartPoolBorrowed()).to.equal(parseUnits("200"));
            });
          });
        });
        describe("AND WHEN john deposits 100 to the same maturity", () => {
          beforeEach(async () => {
            await fixedLenderDAI
              .connect(john)
              .depositToMaturityPool(parseUnits("100"), futurePools(1)[0], parseUnits("100"));
          });
          it("THEN 1200 DAI are still borrowed", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).borrowed).to.equal(parseUnits("1200"));
          });
          it("THEN the maturity pool still doesn't have funds available", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
            expect(borrowed).to.gt(supplied);
          });
          it("THEN the maturity pool still owes 100 to the smart pool", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).suppliedSP).to.equal(parseUnits("100"));
          });
          it("THEN the smart pool was repaid the other 100 (is owed still 100)", async () => {
            expect(await poolAccountingDAI.smartPoolBorrowed()).to.equal(parseUnits("100"));
          });
        });
        describe("AND WHEN john deposits 300 to the same maturity", () => {
          beforeEach(async () => {
            await fixedLenderDAI
              .connect(john)
              .depositToMaturityPool(parseUnits("300"), futurePools(1)[0], parseUnits("300"));
          });
          it("THEN 1200 DAI are still borrowed", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).borrowed).to.equal(parseUnits("1200"));
          });
          it("THEN the maturity pool has 100 DAI available", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
            expect(supplied.sub(borrowed)).to.equal(parseUnits("100"));
          });
          it("THEN the maturity pool doesn't owe the Smart Pool", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).suppliedSP).to.equal(0);
          });
        });
        describe("AND WHEN repaying 100 DAI", () => {
          beforeEach(async () => {
            await fixedLenderDAI.repayToMaturityPool(
              maria.address,
              futurePools(1)[0],
              parseUnits("100"),
              parseUnits("100"),
            );
          });
          it("THEN 1100 DAI are still borrowed", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).borrowed).to.equal(parseUnits("1100"));
          });
          it("THEN the maturity pool doesn't have funds available", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
            expect(borrowed).to.gt(supplied);
          });
          it("THEN the maturity pool still owes 100 to the smart pool (100 repaid)", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).suppliedSP).to.equal(parseUnits("100"));
          });
        });
        describe("AND WHEN repaying 300 DAI", () => {
          beforeEach(async () => {
            await fixedLenderDAI.repayToMaturityPool(
              maria.address,
              futurePools(1)[0],
              parseUnits("300"),
              parseUnits("300"),
            );
          });
          it("THEN 900 DAI are still borrowed", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).borrowed).to.equal(parseUnits("900"));
          });
          it("THEN the maturity pool has 100 DAI available", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
            expect(supplied.sub(borrowed)).to.equal(parseUnits("100"));
          });
          it("THEN the maturity pool doesn't owe the Smart Pool", async () => {
            expect((await poolAccountingDAI.maturityPools(futurePools(1)[0])).suppliedSP).to.equal(0);
          });
        });
        describe("AND WHEN repaying in full (1200 DAI)", () => {
          beforeEach(async () => {
            await fixedLenderDAI.repayToMaturityPool(
              maria.address,
              futurePools(1)[0],
              parseUnits("1200"),
              parseUnits("1200"),
            );
          });
          it("THEN the maturity pool has 1000 DAI available", async () => {
            const [borrowed, supplied] = await poolAccountingDAI.maturityPools(futurePools(1)[0]);
            expect(supplied.sub(borrowed)).to.equal(parseUnits("1000"));
          });
        });
      });
    });
    describe("AND GIVEN she borrows 5k DAI", () => {
      beforeEach(async () => {
        // we first fund the maturity pool so it has liquidity to borrow
        await fixedLenderDAI.depositToMaturityPool(parseUnits("5000"), futurePools(1)[0], parseUnits("5000"));
        await fixedLenderDAI.borrowFromMaturityPool(parseUnits("5000"), futurePools(1)[0], parseUnits("5000"));
      });
      describe("AND WHEN moving in time to 20 days after maturity", () => {
        beforeEach(async () => {
          await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 86_400 * 20]);
        });
        it("THEN Maria owes (getAccountSnapshot) 5k + aprox 2.8k DAI in penalties", async () => {
          await provider.send("evm_mine", []);
          expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.equal(
            parseUnits("5000").add(
              parseUnits("5000")
                .mul(penaltyRate)
                .div(parseUnits("1"))
                .mul(86_400 * 20),
            ),
          );
        });
      });
      describe("AND WHEN moving in time to 20 days after maturity but repaying really small amounts within some days", () => {
        beforeEach(async () => {
          for (const days of [5, 10, 15, 20]) {
            await fixedLenderDAI.repayToMaturityPool(
              maria.address,
              futurePools(1)[0],
              parseUnits("0.000000001"),
              parseUnits("0.000000001"),
            );
            await provider.send("evm_setNextBlockTimestamp", [futurePools(1)[0].toNumber() + 86_400 * days]);
          }
        });
        it("THEN Maria owes (getAccountSnapshot) 5k + aprox 2.8k DAI in penalties (no debt was compounded)", async () => {
          await provider.send("evm_mine", []);
          expect((await fixedLenderDAI.getAccountSnapshot(maria.address, futurePools(1)[0]))[1]).to.be.closeTo(
            parseUnits("5000").add(
              parseUnits("5000")
                .mul(penaltyRate)
                .div(parseUnits("1"))
                .mul(86_400 * 20),
            ),
            parseUnits("0.00000001"),
          );
        });
      });
    });
  });
});
