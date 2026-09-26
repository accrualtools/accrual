# accrual

Yield math for tokenized real-world assets. Day-count conventions, accrued
interest, present value, duration, convexity and loan amortisation.

No network calls, no key material, no signing. It takes numbers and dates and
returns numbers. Zero runtime dependencies.

```
npm install accrual
```

Requires Node 20 or newer. MIT licensed.

- Package: https://www.npmjs.com/package/accrual
- Source: https://github.com/accrualtools/accrual
- Site and calculator: https://accrual.tools

## Why

Every tokenized treasury product quotes a yield. Almost none publish the
day-count convention behind it. The same principal, the same rate and the same
dates produce six different interest figures under the six conventions here.
That spread is not rounding, it is money.

```
accrual days --from 2025-02-28 --to 2025-03-31
```

```
  ACT/360               0.08611111 31.00d / 360
  ACT/365F              0.08493151 31.00d / 365
  ACT/ACT               0.08493151 31.00d / 365
  30U/360               0.08333333 30.00d / 360
  30/360                0.09166667 33.00d / 360
  30E/360               0.08888889 32.00d / 360
```

The three 30/360 variants return 30, 33 and 32 days for the same pair of dates.
They are not interchangeable, and mixing them up is a settlement break rather
than a rounding difference.

## Library

```js
import { accrueSimple, compareConventions, bondMetrics } from 'accrual';

accrueSimple({
  principal: 1_000_000,
  rate: 0.0425,
  from: '2025-01-01',
  to: '2025-04-01',
  convention: 'ACT/360',
});
// { interest: 10625, years: 0.25, days: 90, convention: 'ACT/360' }

// Never pick a convention on someone's behalf. Show the spread.
compareConventions('2025-02-28', '2025-03-31');
```

Rates are decimals: `0.0425` is 4.25%. Dates are `YYYY-MM-DD` strings or `Date`
objects, always read as UTC. An impossible date such as `2025-02-30` throws
rather than rolling forward into March.

### Day count

| function | what it answers |
| --- | --- |
| `yearFraction(from, to, convention)` | the fraction of a year between two dates |
| `compareConventions(from, to)` | all six conventions at once |
| `actualDays(from, to)` | signed calendar days |
| `CONVENTIONS`, `CONVENTION_NOTES` | the supported set and which market uses each |

Supported: `ACT/360`, `ACT/365F`, `ACT/ACT`, `30U/360`, `30/360`, `30E/360`.
Implemented from the ISDA 2006 Definitions section 4.16 and ICMA Rule 251.

### Accrual and pricing

| function | what it answers |
| --- | --- |
| `accrueSimple` | interest over a period, the T-bill and repo convention |
| `accrueCompound` | interest at a compounding frequency, `Infinity` for continuous |
| `effectiveAnnualRate` / `nominalFromEffective` | the only honest way to compare two offers |
| `presentValue` | what a future cashflow is worth now, with the discount factor shown |
| `billYields` | discount yield versus the investment yield you actually earn |
| `bondMetrics` | price, Macaulay and modified duration, convexity, cashflows |
| `priceShock` | price change for a yield move, with and without convexity |

### Loans

| function | what it answers |
| --- | --- |
| `levelPayment` | the payment that retires a loan exactly |
| `amortisationSchedule` | every period, closing at exactly zero |
| `payoffWithExtra` | what overpaying saves, in interest and in years |
| `bulletSchedule` | interest-only with the principal owed at maturity |
| `rateFromPayment` | the rate you are actually paying, solved from the payment |
| `affordablePrincipal` | what a given payment can borrow |

## CLI

```
accrual days        --from 2025-02-28 --to 2025-03-31
accrual accrue      --principal 1000000 --rate 4.25 --from 2025-01-01 --to 2025-04-01
accrual bill        --face 100 --price 97.80 --settle 2025-01-02 --maturity 2025-07-03
accrual bond        --face 1000 --coupon 4 --yield 5 --years 10
accrual pv          --amount 1000 --rate 5 --from 2025-01-01 --to 2026-01-01
accrual loan        --principal 200000 --rate 6 --years 30 --schedule 12
accrual loan        --principal 1000 --payment 150 --years 1
accrual payoff      --principal 200000 --rate 6 --years 30 --extra 200
accrual conventions
```

Rates accept either form: `--rate 4.25` and `--rate 0.0425` mean the same thing.
A bare number above 1 is read as a percentage, so write the sign when the rate is
1% or less: `--rate 1` means 100%, `--rate 1%` means 1%.
Amounts accept separators: `200000`, `200,000` and `200_000` are equivalent.

Exit codes: `0` success, `2` a bad or missing flag, `1` a valid flag whose value
has no meaningful answer.

## MCP server

Thirteen read-only tools over stdio, protocol version `2024-11-05`. An agent
connected here can compute a valuation; it cannot act on one, because there is
no code in this package that could.

```json
{
  "mcpServers": {
    "accrual": {
      "command": "npx",
      "args": ["-y", "accrual", "accrual-mcp"]
    }
  }
}
```

Or point directly at the installed file:

```json
{
  "mcpServers": {
    "accrual": {
      "command": "node",
      "args": ["./node_modules/accrual/mcp/server.mjs"]
    }
  }
}
```

Tools: `day_count`, `year_fraction`, `accrue_simple`, `accrue_compound`,
`bill_yields`, `bond_metrics`, `present_value`, `compare_products`,
`loan_payment`, `loan_schedule`, `loan_payoff`, `loan_implied_rate`,
`loan_affordable`.

Two behaviours worth knowing if you are writing an agent against this:

Input with no meaningful answer comes back as `isError: true` with the reason as
text. It is never a successful response whose fields are `null`. JSON has no
`NaN`, so a `null` produced by a divide-by-zero would read as "no answer given"
rather than "that input has no meaning".

Where a figure is genuinely undefined, the field is `null` and a sibling note
says why. Two cases exist: the percentage of interest saved on an interest-free
loan, and the relative spread between conventions when the lowest one returns a
year fraction of exactly zero. For the second, `widestDisagreementAbs` is still
a real number.

Long results are thinned rather than truncated or refused. A 360-period schedule
returns every row; a 96,000-period one returns a sample with `rowsTotal`,
`rowsReturned` and `everyNthApplied` set, and the totals always describe the
whole loan.

## What it cannot do

It makes no network request, reads no chain state, submits no transaction and
holds no key material. The package has zero runtime dependencies and the three
source modules import nothing but each other. That is the whole security
surface, and it reads in a few minutes.

## Tests

```
npm test
```

152 tests covering the library, the CLI, the MCP protocol surface and the
published browser bundle. Two expected values in the loan tests were wrong on
first writing and were corrected against an independent 40-digit calculation
rather than adjusted to match the code.

## The one rule

Never assume a day-count convention. If a source does not state its own, report
the spread instead of silently picking one. `compareConventions` and the
`day_count` tool exist for exactly that.

Day-count implementations here follow published standards, but your contract
governs. Confirm the convention in your own documents before relying on a
number. This is calculation software; output is not advice, not a quote, and not
a valuation to settle against.

## License

MIT
