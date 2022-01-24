// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import "./interfaces/IInterestRateModel.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./utils/TSUtils.sol";
import "./utils/Errors.sol";
import "./utils/DecimalMath.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

contract InterestRateModel is IInterestRateModel, AccessControl {
    using PoolLib for PoolLib.MaturityPool;
    using DecimalMath for uint256;

    // Parameters to the system, expressed with 1e18 decimals
    uint256 public mpSlopeRate;
    uint256 public spSlopeRate;
    uint256 public spHighURSlopeRate;
    uint256 public baseRate;
    uint256 public slopeChangeRate;
    uint256 public override penaltyRate;

    constructor(
        uint256 _mpSlopeRate,
        uint256 _spSlopeRate,
        uint256 _spHighURSlopeRate,
        uint256 _slopeChangeRate,
        uint256 _baseRate,
        uint256 _penaltyRate
    ) {
        mpSlopeRate = _mpSlopeRate;
        spSlopeRate = _spSlopeRate;
        spHighURSlopeRate = _spHighURSlopeRate;
        slopeChangeRate = _slopeChangeRate;
        baseRate = _baseRate;
        penaltyRate = _penaltyRate;

        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    /**
     * @dev Function to update this model's parameters (DEFAULT_ADMIN_ROLE)
     * @param _mpSlopeRate slope to alter the utilization rate of maturity pool
     * @param _spSlopeRate slope to alter the utilization rate of smart pool
     * @param _spHighURSlopeRate slope when utilization rate is higher than baseRate
     * @param _baseRate rate that defines if we are using _spSlopeRate or _spHighURSlopeRate
     */
    function setParameters(
        uint256 _mpSlopeRate,
        uint256 _spSlopeRate,
        uint256 _spHighURSlopeRate,
        uint256 _slopeChangeRate,
        uint256 _baseRate,
        uint256 _penaltyRate
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        mpSlopeRate = _mpSlopeRate;
        spSlopeRate = _spSlopeRate;
        spHighURSlopeRate = _spHighURSlopeRate;
        slopeChangeRate = _slopeChangeRate;
        baseRate = _baseRate;
        penaltyRate = _penaltyRate;
    }

    /**
     * @dev Get current rate for borrow a certain amount in a certain maturity
     *      with supply/demand values in the maturity pool and supply demand values
     *      in the smart pool
     * @param maturityDate maturity date for calculating days left to maturity
     * @param maturityPool supply/demand values for the maturity pool
     * @param smartPoolTotalDebt demand values for the smart pool
     * @param smartPoolTotalSupply supply values for the smart pool
     * @param newDebt checks if the maturity pool borrows money from the smart pool in this borrow
     */
    function getRateToBorrow(
        uint256 maturityDate,
        PoolLib.MaturityPool memory maturityPool,
        uint256 smartPoolTotalDebt,
        uint256 smartPoolTotalSupply,
        bool newDebt
    ) external view override returns (uint256) {
        if (!TSUtils.isPoolID(maturityDate)) {
            revert GenericError(ErrorCode.INVALID_POOL_ID);
        }

        uint256 daysDifference = (maturityDate -
            TSUtils.trimmedDay(block.timestamp)) / 1 days;
        uint256 yearlyRate;

        if (!newDebt) {
            yearlyRate = maturityPool.supplied == 0
                ? 0
                : baseRate +
                    (mpSlopeRate * maturityPool.borrowed) /
                    maturityPool.supplied;
        } else {
            if (smartPoolTotalSupply == 0) {
                revert GenericError(ErrorCode.INSUFFICIENT_PROTOCOL_LIQUIDITY);
            }
            uint256 smartPoolUtilizationRate = smartPoolTotalDebt.div_(
                smartPoolTotalSupply
            );
            uint256 spCurrentSlopeRate = smartPoolUtilizationRate >=
                slopeChangeRate
                ? spHighURSlopeRate
                : spSlopeRate;

            uint256 smartPoolRate = (spCurrentSlopeRate * smartPoolTotalDebt) /
                smartPoolTotalSupply;
            uint256 maturityPoolRate = maturityPool.supplied == 0
                ? 0
                : baseRate +
                    (mpSlopeRate * maturityPool.borrowed) /
                    maturityPool.supplied;

            yearlyRate = Math.max(smartPoolRate, maturityPoolRate);
        }

        return ((yearlyRate * daysDifference) / 365);
    }

    function getYieldForDeposit(
        uint256 suppliedSP,
        uint256 unassignedEarnings,
        uint256 amount
    ) external pure override returns (uint256 earningsShare) {
        // from now on, it's earnings calculations
        uint256 supply = suppliedSP + amount;
        earningsShare = supply == 0
            ? 0
            : (amount * unassignedEarnings) / supply;
    }
}
