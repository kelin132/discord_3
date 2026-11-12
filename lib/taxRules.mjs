export const TAX_WEALTH_THRESHOLD = 300_000_000;
export const STANDARD_TAX_RATE = 0.10;
export const HIGH_WEALTH_TAX_RATE = 0.20;

export function taxRateForWealth(wealth, isLeaderboardTopTwo = false) {
  return isLeaderboardTopTwo || Number(wealth) >= TAX_WEALTH_THRESHOLD
    ? HIGH_WEALTH_TAX_RATE
    : STANDARD_TAX_RATE;
}

export function wealthTaxExpression(topTwoIds = []) {
  return {
    $cond: [
      {
        $or: [
          {
            $gte: [
              {
                $add: [
                  { $ifNull: ["$money", 0] },
                  { $ifNull: ["$bank", 0] },
                ],
              },
              TAX_WEALTH_THRESHOLD,
            ],
          },
          { $in: ["$_id", topTwoIds] },
        ],
      },
      HIGH_WEALTH_TAX_RATE,
      STANDARD_TAX_RATE,
    ],
  };
}
