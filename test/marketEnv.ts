import { ethers } from "hardhat";
import type { BigNumber } from "ethers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import type {
  Auditor,
  Auditor__factory,
  ERC1967Proxy__factory,
  MarketHarness,
  MarketHarness__factory,
  MockERC20,
  MockERC20__factory,
  MockInterestRateModel,
  MockInterestRateModel__factory,
  MockPriceFeed__factory,
} from "../types";

const {
  utils: { parseUnits },
  getContractFactory,
  getNamedSigner,
  Contract,
  provider,
} = ethers;

/** @deprecated use deploy fixture */
export class MarketEnv {
  mockInterestRateModel: MockInterestRateModel;
  marketHarness: MarketHarness;
  asset: MockERC20;
  currentWallet: SignerWithAddress;

  constructor(
    mockInterestRateModel_: MockInterestRateModel,
    marketHarness_: MarketHarness,
    asset_: MockERC20,
    currentWallet_: SignerWithAddress,
  ) {
    this.mockInterestRateModel = mockInterestRateModel_;
    this.marketHarness = marketHarness_;
    this.asset = asset_;
    this.currentWallet = currentWallet_;
  }

  public async moveInTime(timestamp: number) {
    return provider.send("evm_setNextBlockTimestamp", [timestamp]);
  }

  public switchWallet(wallet: SignerWithAddress) {
    this.currentWallet = wallet;
  }

  public getAllEarnings(fixedPoolState: FixedPoolState) {
    return fixedPoolState.backupEarnings
      .add(fixedPoolState.earningsAccumulator)
      .add(fixedPoolState.earningsMP)
      .add(fixedPoolState.unassignedEarnings)
      .add(fixedPoolState.earningsDiscounted);
  }

  static async create() {
    const owner = await getNamedSigner("deployer");

    const MockInterestRateModelFactory = (await getContractFactory(
      "MockInterestRateModel",
    )) as MockInterestRateModel__factory;
    const mockInterestRateModel = await MockInterestRateModelFactory.deploy(0);
    await mockInterestRateModel.deployed();

    const MockERC20 = (await getContractFactory("MockERC20")) as MockERC20__factory;
    const asset = await MockERC20.deploy("Fake", "F", 18);
    await asset.deployed();

    const Auditor = (await getContractFactory("Auditor")) as Auditor__factory;
    const auditorImpl = await Auditor.deploy(8);
    await auditorImpl.deployed();
    const auditorProxy = await ((await getContractFactory("ERC1967Proxy")) as ERC1967Proxy__factory).deploy(
      auditorImpl.address,
      [],
    );
    await auditorProxy.deployed();
    const auditor = new Contract(auditorProxy.address, Auditor.interface, owner) as Auditor;
    await auditor.initialize({ liquidator: parseUnits("0.1"), lenders: 0 });

    const MarketHarness = (await getContractFactory("MarketHarness")) as MarketHarness__factory;
    const marketHarness = await MarketHarness.deploy(
      asset.address,
      4,
      parseUnits("1"),
      auditor.address,
      mockInterestRateModel.address,
      parseUnits("0.02").div(86_400),
      0, // SP rate if 0 then no fees charged for the mp depositors' yield
      0,
      parseUnits("0.0046"),
      parseUnits("0.42"),
    );
    await marketHarness.deployed();
    const MockPriceFeed = (await getContractFactory("MockPriceFeed")) as MockPriceFeed__factory;
    const mockPriceFeed = await MockPriceFeed.deploy(8, parseUnits("1", 8));
    await mockPriceFeed.deployed();
    await auditor.enableMarket(marketHarness.address, mockPriceFeed.address, parseUnits("0.9"));

    return new MarketEnv(mockInterestRateModel, marketHarness, asset, owner);
  }
}

export type FixedPoolState = {
  borrowFees: BigNumber;
  unassignedEarnings: BigNumber;
  backupEarnings: BigNumber;
  earningsAccumulator: BigNumber;
  earningsMP: BigNumber;
  earningsDiscounted: BigNumber;
};
