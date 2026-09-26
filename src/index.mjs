// accrual — yield math for tokenized real-world assets.
//
// Read only by construction. No RPC client, no signer, no key material, no
// network calls anywhere in this package. It takes numbers and dates and
// returns numbers. Verify that claim by reading the imports: there are none
// outside this directory.

export {
  CONVENTIONS,
  CONVENTION_NOTES,
  toUTCDate,
  actualDays,
  isLeapYear,
  daysInYear,
  yearFraction,
  compareConventions,
} from './daycount.mjs';

export {
  accrueSimple,
  accrueCompound,
  effectiveAnnualRate,
  nominalFromEffective,
  presentValue,
  billYields,
  bondMetrics,
  priceShock,
} from './accrue.mjs';

export {
  levelPayment,
  amortisationSchedule,
  payoffWithExtra,
  bulletSchedule,
  rateFromPayment,
  affordablePrincipal,
} from './amortise.mjs';

export const TOKEN = Object.freeze({
  name: 'accrual',
  symbol: 'ACCR',
  chain: 'Robinhood Chain',
  launchpad: 'pons v2',
  site: 'https://accrual.tools',
});
