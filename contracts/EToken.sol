// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.4;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "./interfaces/IEToken.sol";
import "./interfaces/IExafin.sol";
import "./utils/Errors.sol";
import "./utils/DecimalMath.sol";

contract EToken is ERC20, IEToken, AccessControl {
    using DecimalMath for uint256;

    // totalBalance = smart pool's balance
    uint256 public totalBalance;
    // index = totalBalance / totalScaledBalance
    uint256 public totalScaledBalance;
    // userBalance = userScaledBalance * index
    mapping(address => uint256) public userScaledBalance;

    IExafin private exafin;

    constructor(string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {
        _setupRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    modifier onlyExafin() {
        if (_msgSender() != address(exafin)) {
            revert GenericError(ErrorCode.CALLER_MUST_BE_EXAFIN);
        }
        _;
    }

    /**
     * @dev Returns the total supply of the eToken
     * @return The current total supply
     **/
    function totalSupply()
        public
        view
        override(ERC20, IERC20)
        returns (uint256)
    {
        return totalBalance;
    }

    /**
     * @dev Calculates the balance of the user: principal balance + interest generated by the principal
     * @param account The user whose balance is calculated
     * @return The balance of the user
     **/
    function balanceOf(address account)
        public
        view
        override(ERC20, IERC20)
        returns (uint256)
    {
        if (userScaledBalance[account] == 0) {
            return 0;
        }

        return (userScaledBalance[account] * totalBalance) / totalScaledBalance;
    }

    /**
     * @dev Mints `amount` eTokens to `user`
     * - Only callable by the Exafin
     * @param user The address receiving the minted tokens
     * @param amount The amount of tokens getting minted
     */
    function mint(address user, uint256 amount) external override onlyExafin {
        if (user == address(0)) {
            revert GenericError(ErrorCode.MINT_NOT_TO_ZERO_ADDRESS);
        }

        uint256 scaledBalance = amount;
        if (totalBalance != 0) {
            scaledBalance = (scaledBalance * totalScaledBalance) / totalBalance;
        }

        userScaledBalance[user] += scaledBalance;
        totalScaledBalance += scaledBalance;
        totalBalance += amount;

        emit Transfer(address(0), user, amount);
    }

    /**
     * @dev Increases contract earnings
     * - Only callable by the Exafin
     * @param amount The amount of underlying tokens deposited
     */
    function accrueEarnings(uint256 amount) external override onlyExafin {
        totalBalance += amount;
        emit EarningsAccrued(amount);
    }

    /**
     * @dev Burns eTokens from `user`
     * - Only callable by the Exafin
     * @param user The owner of the eTokens, getting them burned
     * @param amount The amount being burned
     */
    function burn(address user, uint256 amount) external override onlyExafin {
        if (balanceOf(user) < amount) {
            revert GenericError(ErrorCode.BURN_AMOUNT_EXCEEDS_BALANCE);
        }

        uint256 scaledWithdrawAmount = (amount * totalScaledBalance) /
            totalBalance;

        totalScaledBalance -= scaledWithdrawAmount;
        userScaledBalance[user] -= scaledWithdrawAmount;
        totalBalance -= amount;
    }

    /**
     * @dev Sets the Exafin where this eToken is used
     * - Only able to set the Exafin once
     * @param exafinAddress The address of the Exafin that uses this eToken
     */
    function setExafin(address exafinAddress)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (address(exafin) != address(0)) {
            revert GenericError(ErrorCode.EXAFIN_ALREADY_SETTED);
        }
        exafin = IExafin(exafinAddress);

        emit ExafinSetted(exafinAddress);
    }
}
