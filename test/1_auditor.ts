import { expect } from "chai";
import { ethers } from "hardhat";
import { parseUnits } from "@ethersproject/units";
import { Contract } from "ethers";
import { BigNumber } from "@ethersproject/bignumber";
import {
  ProtocolError,
  ExactlyEnv,
  ExaTime,
  parseSupplyEvent,
  errorGeneric,
  DefaultEnv,
} from "./exactlyUtils";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";

describe("Auditor from User Space", function () {
  let auditor: Contract;
  let exactlyEnv: DefaultEnv;
  let nextPoolID: number;

  let owner: SignerWithAddress;
  let user: SignerWithAddress;

  let mockedTokens = new Map([
    [
      "DAI",
      {
        decimals: 18,
        collateralRate: parseUnits("0.8"),
        usdPrice: parseUnits("1"),
      },
    ],
    [
      "ETH",
      {
        decimals: 18,
        collateralRate: parseUnits("0.7"),
        usdPrice: parseUnits("3000"),
      },
    ],
    [
      "WBTC",
      {
        decimals: 8,
        collateralRate: parseUnits("0.6"),
        usdPrice: parseUnits("63000"),
      },
    ],
  ]);

  let closeFactor = parseUnits("0.4");

  let snapshot: any;
  before(async () => {
    snapshot = await ethers.provider.send("evm_snapshot", []);
  });

  beforeEach(async () => {
    [owner, user] = await ethers.getSigners();

    exactlyEnv = await ExactlyEnv.create(mockedTokens);
    auditor = exactlyEnv.auditor;
    nextPoolID = new ExaTime().nextPoolID();

    // From Owner to User
    await exactlyEnv
      .getUnderlying("DAI")
      .transfer(user.address, parseUnits("100000"));
  });

  it("We try to enter an unlisted market and fail", async () => {
    await expect(
      auditor.enterMarkets([exactlyEnv.notAnExafinAddress])
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("We enter market twice without failing", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await auditor.enterMarkets([exafinDAI.address]);
    await expect(auditor.enterMarkets([exafinDAI.address])).to.not.be.reverted;
  });

  it("SupplyAllowed should fail for an unlisted market", async () => {
    await expect(
      auditor.supplyAllowed(
        exactlyEnv.notAnExafinAddress,
        owner.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("BorrowAllowed should fail for an unlisted market", async () => {
    await expect(
      auditor.borrowAllowed(
        exactlyEnv.notAnExafinAddress,
        owner.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("BorrowAllowed should fail for when oracle gets weird", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");

    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    await exafinDAI.supply(owner.address, amountDAI, nextPoolID);

    await auditor.enterMarkets([exafinDAI.address]);

    await exactlyEnv.oracle.setPrice("DAI", 0);
    await expect(
      auditor.borrowAllowed(exafinDAI.address, owner.address, 100, nextPoolID)
    ).to.be.revertedWith(errorGeneric(ProtocolError.PRICE_ERROR));
  });

  it("RedeemAllowed should fail for an unlisted market", async () => {
    await expect(
      auditor.redeemAllowed(
        exactlyEnv.notAnExafinAddress,
        owner.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("RepayAllowed should fail for an unlisted market", async () => {
    await expect(
      auditor.repayAllowed(
        exactlyEnv.notAnExafinAddress,
        owner.address,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("SeizeAllowed should fail for an unlisted market", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await expect(
      auditor.seizeAllowed(
        exactlyEnv.notAnExafinAddress,
        exafinDAI.address,
        owner.address,
        user.address
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("SeizeAllowed should fail when liquidator is borrower", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await expect(
      auditor.seizeAllowed(
        exafinDAI.address,
        exafinDAI.address,
        owner.address,
        owner.address
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.LIQUIDATOR_NOT_BORROWER));
  });

  it("LiquidateAllowed should fail for unlisted markets", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await expect(
      auditor.liquidateAllowed(
        exactlyEnv.notAnExafinAddress,
        exafinDAI.address,
        owner.address,
        user.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
    await expect(
      auditor.liquidateAllowed(
        exafinDAI.address,
        exactlyEnv.notAnExafinAddress,
        owner.address,
        user.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
    await expect(
      auditor.liquidateAllowed(
        exafinDAI.address,
        exafinDAI.address,
        owner.address,
        user.address,
        100,
        nextPoolID
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.UNSUFFICIENT_SHORTFALL)); // Any failure except MARKET_NOT_LISTED
  });

  it("PauseBorrow should fail for an unlisted market", async () => {
    await expect(
      auditor.pauseBorrow(exactlyEnv.notAnExafinAddress, true)
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_NOT_LISTED));
  });

  it("PauseBorrow should emit event", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await expect(auditor.pauseBorrow(exafinDAI.address, true)).to.emit(
      auditor,
      "ActionPaused"
    );
  });

  it("PauseBorrow should block borrowing on a listed market", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");
    await auditor.pauseBorrow(exafinDAI.address, true);
    // we supply Dai to the protocol
    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    await exafinDAI.supply(owner.address, amountDAI, nextPoolID);

    // we make it count as collateral (DAI)
    await auditor.enterMarkets([exafinDAI.address]);
    await expect(
      // user borrows half of it's collateral
      exafinDAI.borrow(amountDAI.div(2), nextPoolID)
    ).to.be.revertedWith(errorGeneric(ProtocolError.BORROW_PAUSED));
  });

  it("Autoadding a market should only be allowed from an exafin", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");

    // we supply Dai to the protocol
    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    await exafinDAI.supply(owner.address, amountDAI, nextPoolID);

    // we make it count as collateral (DAI)
    await expect(
      auditor.borrowAllowed(exafinDAI.address, owner.address, 100, nextPoolID)
    ).to.be.revertedWith(errorGeneric(ProtocolError.NOT_AN_EXAFIN_SENDER));
  });

  it("SetBorrowCap should emit event", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await expect(
      auditor.setMarketBorrowCaps([exafinDAI.address], [10])
    ).to.emit(auditor, "NewBorrowCap");
  });

  it("SetBorrowCap should block borrowing more than the cap on a listed market", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");
    await auditor.setMarketBorrowCaps([exafinDAI.address], [10]);
    // we supply Dai to the protocol
    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    await exafinDAI.supply(owner.address, amountDAI, nextPoolID);

    await expect(
      // user tries to borrow more than the cap
      exafinDAI.borrow(20, nextPoolID)
    ).to.be.revertedWith(errorGeneric(ProtocolError.MARKET_BORROW_CAP_REACHED));
  });

  it("LiquidateCalculateSeizeAmount should fail when oracle is acting weird", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    await exactlyEnv.setOracleMockPrice("DAI", "0");
    await expect(
      auditor.liquidateCalculateSeizeAmount(
        exafinDAI.address,
        exafinDAI.address,
        100
      )
    ).to.be.revertedWith(errorGeneric(ProtocolError.PRICE_ERROR));
  });

  it("Future pools should match JS generated ones", async () => {
    let exaTime = new ExaTime();
    let poolsInContract = await auditor.callStatic.getFuturePools();
    let poolsInJS = exaTime.futurePools(12).map((item) => BigNumber.from(item));
    for (let i = 0; i < 12; i++) {
      expect(poolsInContract[i]).to.be.equal(poolsInJS[i]);
    }
  });

  it("we deposit dai & eth to the protocol and we use them both for collateral to take a loan", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");

    // we supply Dai to the protocol
    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    let txDAI = await exafinDAI.supply(owner.address, amountDAI, nextPoolID);
    let borrowDAIEvent = await parseSupplyEvent(txDAI);

    expect(await dai.balanceOf(exafinDAI.address)).to.equal(amountDAI);

    // we make it count as collateral (DAI)
    await auditor.enterMarkets([exafinDAI.address]);

    const exafinETH = exactlyEnv.getExafin("ETH");
    const eth = exactlyEnv.getUnderlying("ETH");

    // we supply Eth to the protocol
    const amountETH = parseUnits("1");
    await eth.approve(exafinETH.address, amountETH);
    let txETH = await exafinETH.supply(owner.address, amountETH, nextPoolID);
    let borrowETHEvent = await parseSupplyEvent(txETH);

    expect(await eth.balanceOf(exafinETH.address)).to.equal(amountETH);

    // we make it count as collateral (ETH)
    await auditor.enterMarkets([exafinETH.address]);

    let liquidity = (
      await auditor.getAccountLiquidity(owner.address, nextPoolID)
    )[0];
    let collaterDAI = amountDAI
      .add(borrowDAIEvent.commission)
      .mul(mockedTokens.get("DAI")!.collateralRate)
      .div(parseUnits("1"))
      .mul(mockedTokens.get("DAI")!.usdPrice)
      .div(parseUnits("1"));

    let collaterETH = amountETH
      .add(borrowETHEvent.commission)
      .mul(mockedTokens.get("ETH")!.collateralRate)
      .div(parseUnits("1"))
      .mul(mockedTokens.get("ETH")!.usdPrice)
      .div(parseUnits("1"));

    expect(liquidity).to.be.equal(collaterDAI.add(collaterETH));
  });

  it("Auditor reverts if Oracle acts weird", async () => {
    const exafinDAI = exactlyEnv.getExafin("DAI");
    const dai = exactlyEnv.getUnderlying("DAI");

    // we supply Dai to the protocol
    const amountDAI = parseUnits("100");
    await dai.approve(exafinDAI.address, amountDAI);
    await exafinDAI.supply(owner.address, amountDAI, nextPoolID);

    // we make it count as collateral (DAI)
    await auditor.enterMarkets([exafinDAI.address]);

    await exactlyEnv.oracle.setPrice("DAI", 0);
    await expect(
      auditor.getAccountLiquidity(owner.address, nextPoolID)
    ).to.revertedWith(errorGeneric(ProtocolError.PRICE_ERROR));
  });

  after(async () => {
    await ethers.provider.send("evm_revert", [snapshot]);
    await ethers.provider.send("evm_mine", []);
  });
});
