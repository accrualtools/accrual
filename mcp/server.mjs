#!/usr/bin/env node
// MCP server over stdio. Exposes accrual's math as read-only tools.
//
// Hand-rolled JSON-RPC 2.0 so the package stays dependency free. An agent
// that connects here can compute yields; it cannot make a transaction,
// because there is no code in this package that could.

import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';
import {
  CONVENTIONS,
  CONVENTION_NOTES,
  compareConventions,
  actualDays,
  yearFraction,
  accrueSimple,
  accrueCompound,
  effectiveAnnualRate,
  presentValue,
  billYields,
  bondMetrics,
  priceShock,
  levelPayment,
  amortisationSchedule,
  payoffWithExtra,
  bulletSchedule,
  rateFromPayment,
  affordablePrincipal,
} from '../src/index.mjs';

const PROTOCOL_VERSION = '2024-11-05';
// Kept in step with package.json by a test rather than by hope. The served copy
// in public/ has no package.json beside it, so this cannot be read at runtime.
const SERVER_VERSION = '0.1.1';

// A ratio whose denominator can legitimately be zero. JSON has no NaN, so an
// unguarded 0/0 is serialised as null, and a model reads null as "the tool
// declined to answer" rather than "there is nothing to compare". Return null
// deliberately, with a sibling field that says why, instead of by accident.
const ratio = (numerator, denominator) =>
  denominator === 0 ? null : numerator / denominator;

const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'YYYY-MM-DD' };
const conventionSchema = {
  type: 'string',
  enum: [...CONVENTIONS],
  description: 'day-count convention. the three 30/360 variants are not interchangeable.',
};

const TOOLS = [
  {
    name: 'day_count',
    description:
      'Year fraction between two dates under every supported day-count convention, so you can see the disagreement instead of trusting one number.',
    inputSchema: {
      type: 'object',
      properties: { from: dateSchema, to: dateSchema },
      required: ['from', 'to'],
    },
    handler: ({ from, to }) => {
      const spread = compareConventions(from, to);
      const vals = Object.values(spread);
      const max = Math.max(...vals);
      const min = Math.min(...vals);
      // Relative to the smallest figure, which is 0 whenever a convention
      // decides no time passed at all: identical dates, or a pair like
      // 2025-01-30 to 2025-01-31 that the 30/360 family collapses to zero days.
      // Dividing there gave Infinity or NaN and the field serialised as null.
      const relative = ratio(max - min, Math.abs(min));
      return {
        from,
        to,
        actualDays: actualDays(from, to),
        conventions: Object.fromEntries(
          Object.entries(spread).map(([k, v]) => [
            k,
            { yearFraction: v, equivalentDays: v * (k.endsWith('/360') ? 360 : 365), note: CONVENTION_NOTES[k] },
          ])
        ),
        widestDisagreementAbs: max - min,
        widestDisagreementPct: relative === null ? null : relative * 100,
        widestDisagreementNote:
          relative === null
            ? 'no percentage is defined: the lowest convention returns a year fraction of 0, so compare widestDisagreementAbs instead.'
            : 'percentage is relative to the lowest convention.',
      };
    },
  },
  {
    name: 'accrue_simple',
    description:
      'Simple interest accrued over a period. The convention for T-bills, repo, commercial paper and most tokenized cash. Returns the result under every convention so the choice is visible.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number', minimum: 0 },
        rate: { type: 'number', description: 'annual rate as a decimal, 0.0425 for 4.25%' },
        from: dateSchema,
        to: dateSchema,
        convention: conventionSchema,
      },
      required: ['principal', 'rate', 'from', 'to'],
    },
    handler: (a) => {
      const convention = a.convention || 'ACT/360';
      const chosen = accrueSimple({ ...a, convention });
      const all = {};
      for (const c of CONVENTIONS) {
        all[c] = accrueSimple({ ...a, convention: c }).interest;
      }
      return { ...chosen, total: a.principal + chosen.interest, interestByConvention: all };
    },
  },
  {
    name: 'accrue_compound',
    description:
      'Compound interest over a period at a given frequency. Pass periodsPerYear as null for continuous compounding. Also returns the effective annual rate, which is the only number that compares two products honestly.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number', minimum: 0 },
        rate: { type: 'number', description: 'annual nominal rate as a decimal' },
        from: dateSchema,
        to: dateSchema,
        periodsPerYear: {
          type: ['number', 'null'],
          description: 'compounding frequency. null means continuous.',
        },
        convention: conventionSchema,
      },
      required: ['principal', 'rate', 'from', 'to'],
    },
    handler: (a) => {
      const m = a.periodsPerYear === null || a.periodsPerYear === undefined ? 1 : a.periodsPerYear;
      const periodsPerYear = a.periodsPerYear === null ? Infinity : m;
      const res = accrueCompound({ ...a, periodsPerYear });
      return {
        ...res,
        periodsPerYear: periodsPerYear === Infinity ? 'continuous' : periodsPerYear,
        effectiveAnnualRate: effectiveAnnualRate(a.rate, periodsPerYear),
        nominalRate: a.rate,
      };
    },
  },
  {
    name: 'bill_yields',
    description:
      'Discount yield versus investment (coupon-equivalent) yield for a bill bought below par. These are different numbers and only the second one is what you earn. Use this before believing a quoted T-bill rate.',
    inputSchema: {
      type: 'object',
      properties: {
        face: { type: 'number', minimum: 0 },
        price: { type: 'number', exclusiveMinimum: 0 },
        settle: dateSchema,
        maturity: dateSchema,
      },
      required: ['face', 'price', 'settle', 'maturity'],
    },
    handler: (a) => {
      const r = billYields(a);
      return { ...r, gapBp: (r.investmentYield - r.discountYield) * 10000 };
    },

  },
  {
    name: 'bond_metrics',
    description:
      'Price, Macaulay duration, modified duration and convexity for a level-coupon bond, plus the full discounted cashflow schedule. Modified duration is the rate sensitivity that tokenized bond products rarely disclose.',
    inputSchema: {
      type: 'object',
      properties: {
        face: { type: 'number', minimum: 0 },
        couponRate: { type: 'number', description: 'annual, decimal' },
        yield: { type: 'number', description: 'annual yield to maturity, decimal' },
        years: { type: 'number', minimum: 0 },
        periodsPerYear: { type: 'number', default: 2 },
      },
      required: ['face', 'couponRate', 'yield', 'years'],
    },
    handler: (a) => {
      const r = bondMetrics(a);
      const shocks = {};
      for (const bp of [-200, -100, -50, 50, 100, 200]) {
        const s = priceShock(r.price, r.modified, r.convexity, bp / 10000);
        const rel = ratio(s.withConvexity - r.price, r.price);
        shocks[`${bp > 0 ? '+' : ''}${bp}bp`] = {
          price: s.withConvexity,
          pctChange: rel === null ? null : rel * 100,
        };
      }
      // One cashflow row per coupon period. A 50,000 year bond is 100,000 rows
      // and about 11 MB of JSON, which no model can read. Every metric above
      // is computed from the whole schedule regardless, so thinning the rows
      // costs the caller nothing but the row-by-row detail.
      const MAX_CASHFLOWS = 600;
      const step = Math.max(1, Math.ceil(r.cashflows.length / MAX_CASHFLOWS));
      const cashflows =
        step === 1
          ? r.cashflows
          : r.cashflows.filter(
              (c, i) => i === 0 || i === r.cashflows.length - 1 || c.period % step === 0,
            );
      return {
        price: r.price,
        pricePer100: (r.price / a.face) * 100,
        macaulayDuration: r.macaulay,

        modifiedDuration: r.modified,
        convexity: r.convexity,
        yieldShocks: shocks,
        // every figure above reflects all cashflowsTotal periods, not just these
        cashflowsTotal: r.cashflows.length,
        cashflowsReturned: cashflows.length,
        everyNthApplied: step,
        cashflows,
      };
    },
  },
  {
    name: 'present_value',
    description: 'Present value of a single future cashflow, with the discount factor shown.',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number' },
        rate: { type: 'number', description: 'annual discount rate as a decimal' },
        from: { ...dateSchema, description: 'valuation date, YYYY-MM-DD' },
        to: { ...dateSchema, description: 'cashflow date, YYYY-MM-DD' },
        periodsPerYear: { type: ['number', 'null'], description: 'null means continuous' },
        convention: conventionSchema,
      },
      required: ['amount', 'rate', 'from', 'to'],
    },
    handler: (a) =>
      presentValue({
        ...a,
        periodsPerYear: a.periodsPerYear === null ? Infinity : (a.periodsPerYear ?? 1),
      }),
  },
  {
    name: 'compare_products',
    description:
      'Put two yield offers on the same footing. Converts both to an effective annual rate, which is the only fair comparison when frequencies or conventions differ. Returns which one actually pays more and by how much.',
    inputSchema: {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            rate: { type: 'number' },
            periodsPerYear: { type: ['number', 'null'] },
          },
          required: ['rate'],
        },
        b: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            rate: { type: 'number' },
            periodsPerYear: { type: ['number', 'null'] },
          },
          required: ['rate'],
        },
      },
      required: ['a', 'b'],
    },
    handler: ({ a, b }) => {
      const ear = (x) =>
        effectiveAnnualRate(x.rate, x.periodsPerYear === null ? Infinity : (x.periodsPerYear ?? 1));
      const ea = ear(a);
      const eb = ear(b);
      return {
        a: { label: a.label || 'a', nominalRate: a.rate, effectiveAnnualRate: ea },
        b: { label: b.label || 'b', nominalRate: b.rate, effectiveAnnualRate: eb },
        higher: ea === eb ? 'tie' : ea > eb ? a.label || 'a' : b.label || 'b',
        differenceBp: Math.abs(ea - eb) * 10000,
        note:
          'A higher nominal rate can lose to a lower one compounded more often. Compare on effective annual rate only.',
      };
    },
  },
  {
    name: 'year_fraction',
    description: 'Year fraction for one specific convention, when you already know which you need.',
    inputSchema: {
      type: 'object',
      properties: { from: dateSchema, to: dateSchema, convention: conventionSchema },
      required: ['from', 'to', 'convention'],
    },
    handler: ({ from, to, convention }) => ({
      from,
      to,
      convention,
      yearFraction: yearFraction(from, to, convention),
      actualDays: actualDays(from, to),
      note: CONVENTION_NOTES[convention],
    }),
  },
  {
    name: 'loan_payment',
    description:
      'Level payment, total interest and the first-payment split for a loan. Works for mortgages, car loans and any amortising debt. Set bullet true for interest-only with the principal owed at maturity.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number', description: 'amount borrowed' },
        rate: { type: 'number', description: 'annual nominal rate as a decimal, 0.06 for 6%' },
        years: { type: 'number' },
        periodsPerYear: { type: 'number', default: 12, description: '12 for monthly' },
        bullet: { type: 'boolean', default: false, description: 'interest-only with a balloon' },
      },
      required: ['principal', 'rate', 'years'],
    },
    handler: ({ principal, rate, years, periodsPerYear = 12, bullet = false }) => {
      const opts = { principal, rate, years, periodsPerYear };
      if (bullet) {
        const b = bulletSchedule(opts);
        const l = levelPayment(opts);
        return {
          type: 'interest-only',
          payment: b.payment,
          balloonAtMaturity: b.balloon,
          periods: b.periods,
          totalInterest: b.totalInterest,
          totalPaid: b.totalPaid,
          amortisingAlternative: { payment: l.payment, totalInterest: l.totalInterest },
          extraInterestVsAmortising: b.totalInterest - l.totalInterest,
          note: 'The periodic payment is lower, the total cost is higher, and the full principal is still owed on the last day.',
        };
      }
      const s = amortisationSchedule(opts);
      const first = s.rows[0];
      const firstShare = ratio(first.interest, first.payment);
      return {
        type: 'amortising',
        payment: s.payment,
        periods: s.periods,
        totalPaid: s.totalPaid,
        totalInterest: s.totalInterest,
        interestAsPctOfPrincipal: (s.totalInterest / principal) * 100,
        firstPayment: {
          interest: first.interest,
          principal: first.principal,
          interestSharePct: firstShare === null ? null : firstShare * 100,
        },
        finalPaymentAdjustedBy: s.finalAdjusted,
        note: 'Early payments are mostly interest. The split reverses over the term.',
      };
    },
  },
  {
    name: 'loan_schedule',
    description:
      'Full amortisation schedule, one row per period, each with payment, interest, principal and closing balance. The last row closes at exactly zero.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number' },
        rate: { type: 'number', description: 'annual nominal rate as a decimal' },
        years: { type: 'number' },
        periodsPerYear: { type: 'number', default: 12 },
        extraPayment: { type: 'number', default: 0, description: 'extra principal each period' },
        everyNth: { type: 'number', default: 1, description: 'return every Nth row to keep the response small' },
      },
      required: ['principal', 'rate', 'years'],
    },
    handler: ({ principal, rate, years, periodsPerYear = 12, extraPayment = 0, everyNth = 1 }) => {
      const s = amortisationSchedule({ principal, rate, years, periodsPerYear, extraPayment });
      // The caller is a language model with a finite context window. A 96,000
      // period schedule serialises to about 14 MB, which is somewhere north of
      // three million tokens: it would not overflow the context so much as
      // never arrive. everyNth defaults to 1, so nothing here is the caller's
      // fault. Thin the rows automatically and say so in the response, rather
      // than either truncating silently or returning something unusable.
      const MAX_ROWS = 600;
      let step = Math.max(1, Math.floor(everyNth) || 1);
      if (s.rows.length / step > MAX_ROWS) step = Math.ceil(s.rows.length / MAX_ROWS);
      const rows = s.rows.filter(
        (r) => r.period === 1 || r.period === s.periods || r.period % step === 0
      );
      return {
        payment: s.payment,
        periods: s.periods,
        totalPaid: s.totalPaid,
        totalInterest: s.totalInterest,
        finalPaymentAdjustedBy: s.finalAdjusted,
        rowsReturned: rows.length,
        rowsTotal: s.rows.length,
        // totals above always describe the whole loan, never just these rows
        everyNthApplied: step,
        thinned: step !== (Math.max(1, Math.floor(everyNth) || 1)),
        rows,
      };
    },
  },
  {
    name: 'loan_payoff',
    description:
      'What overpaying a loan is worth: interest saved and how much sooner it clears. The payment rises, the term shortens.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number' },
        rate: { type: 'number', description: 'annual nominal rate as a decimal' },
        years: { type: 'number' },
        periodsPerYear: { type: 'number', default: 12 },
        extraPayment: { type: 'number', description: 'extra principal each period' },
      },
      required: ['principal', 'rate', 'years', 'extraPayment'],
    },
    handler: ({ principal, rate, years, periodsPerYear = 12, extraPayment }) => {
      const p = payoffWithExtra({ principal, rate, years, periodsPerYear, extraPayment });
      // An interest-free loan has no interest to save, so the percentage is 0/0.
      // That is a real input: rate 0 is accepted everywhere else in this package.
      const savedShare = ratio(p.interestSaved, p.baseInterest);
      return {
        scheduledPayment: p.payment,
        newPayment: p.newPayment,
        interestSaved: p.interestSaved,
        interestSavedPct: savedShare === null ? null : savedShare * 100,
        periodsSaved: p.periodsSaved,
        yearsSaved: p.yearsSaved,
        baseInterest: p.baseInterest,
        newInterest: p.newInterest,
        totalExtraPaid: extraPayment * p.newPeriods,
        note:
          savedShare === null
            ? 'interestSavedPct is null because the loan is interest-free, so there is no interest to save. The term still shortens: see periodsSaved.'
            : 'Every extra unit goes straight to principal, so it removes all the future interest that principal would have carried.',
      };
    },
  },
  {
    name: 'loan_implied_rate',
    description:
      'The rate you are actually paying, solved from the payment. Use this to check a quoted rate or to price a loan described only as "X per month". Returns both nominal and effective annual.',
    inputSchema: {
      type: 'object',
      properties: {
        principal: { type: 'number' },
        payment: { type: 'number', description: 'per-period payment' },
        years: { type: 'number' },
        periodsPerYear: { type: 'number', default: 12 },
      },
      required: ['principal', 'payment', 'years'],
    },
    handler: ({ principal, payment, years, periodsPerYear = 12 }) => {
      const r = rateFromPayment({ principal, payment, years, periodsPerYear });
      return {
        nominalAnnualRate: r.rate,
        nominalAnnualPct: r.rate * 100,
        effectiveAnnualRate: Math.pow(1 + r.periodicRate, periodsPerYear) - 1,
        effectiveAnnualPct: (Math.pow(1 + r.periodicRate, periodsPerYear) - 1) * 100,
        periodicRate: r.periodicRate,
        totalPaid: r.totalPaid,
        totalInterest: r.totalInterest,
        note: 'The nominal rate is what gets advertised. The effective annual rate is what the borrower pays. Both are correct; they answer different questions.',
      };
    },
  },
  {
    name: 'loan_affordable',
    description:
      'How much you can borrow for a given payment. The inverse of loan_payment, and the question a borrower actually starts with.',
    inputSchema: {
      type: 'object',
      properties: {
        payment: { type: 'number', description: 'affordable per-period payment' },
        rate: { type: 'number', description: 'annual nominal rate as a decimal' },
        years: { type: 'number' },
        periodsPerYear: { type: 'number', default: 12 },
      },
      required: ['payment', 'rate', 'years'],
    },
    handler: ({ payment, rate, years, periodsPerYear = 12 }) => {
      const a = affordablePrincipal({ payment, rate, years, periodsPerYear });
      return {
        canBorrow: a.principal,
        periods: a.periods,
        totalPaid: a.totalPaid,
        totalInterest: a.totalInterest,
        note: 'Raising the rate lowers this figure sharply on long terms.',
      };
    },
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function result(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}
function failure(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function handle(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      return result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'accrual', version: SERVER_VERSION },
        instructions:
          'Yield math for tokenized real-world assets. Every tool is a pure function over numbers and dates. There is no RPC client, no signer and no key material in this server, so it can compute a valuation but cannot act on one.',
      });

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return result(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = byName.get(params?.name);
      if (!tool) return failure(id, -32602, `unknown tool ${JSON.stringify(params?.name)}`);
      try {
        const out = tool.handler(params.arguments || {});
        return result(id, {
          content: [{ type: 'text', text: JSON.stringify(out, null, 2) }],
          isError: false,
        });
      } catch (err) {
        return result(id, {
          content: [{ type: 'text', text: `${err.name}: ${err.message}` }],
          isError: true,
        });
      }
    }

    case 'ping':
      return result(id, {});

    default:
      return id === undefined ? null : failure(id, -32601, `unsupported method ${method}`);
  }
}

/**
 * Line-delimited JSON on stdin, one response per line on stdout.
 * Exported so the protocol layer can be tested, and so anything importing this
 * module gets the handler without a side effect.
 */
export function serve(input = process.stdin, output = process.stdout) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;

      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        output.write(JSON.stringify(failure(null, -32700, 'parse error')) + '\n');
        continue;
      }
      const response = handle(msg);
      if (response) output.write(JSON.stringify(response) + '\n');
    }
  });

  input.on('end', () => process.exit(0));
}

export { handle, TOOLS };

// Only claim stdin when run as a program. Importing this file used to attach a
// stdin listener as a side effect, which left the importing process holding an
// open handle it never asked for: the process could not exit, and anything else
// reading stdin got nothing. Under `node --test` that is an indefinite hang.
//
// The comparison has to go through realpath. npm installs a bin as a symlink in
// node_modules/.bin, and Node resolves symlinks for import.meta.url but not for
// argv[1], so comparing them directly says "imported" for the one invocation
// every MCP client actually uses, and the server starts up silent.
function isMain() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMain()) serve();
