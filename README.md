# actual-amazon

Helper for reconciling Amazon purchases against Actual Budget.

By default, `actual-amazon` fetches Amazon data, matches it against unmatched Actual transactions, and applies matched updates to Actual. Multi-item charges become splits; single-item charges keep the base transaction and set its note. Use `--dry-run` to preview without modifying Actual.

## Install

```bash
cd ~/Code/actual-amazon
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
npm install
cp .env.example .env
```

Fill in `.env` with your Actual server URL, server password, budget sync ID, and account name. Matching currently scans all transactions in the configured account and only considers uncategorized Amazon transactions.

## Normal run

```bash
actual-amazon
```

The command:

1. Reads unmatched Amazon transactions from the configured Actual account.
2. Finds the earliest unmatched date and subtracts a 7-day safety window.
3. Fetches Amazon order and charge data from that date forward.
4. Matches Amazon charge transactions to Actual transactions.
5. Writes a report to `output/match-proposals.json`.
6. Applies matched updates to Actual: split multi-item charges, set base notes for single-item charges.
7. Prints a formatted match list, note/split lines, unmatched transactions, and skipped updates.

Optional arguments:

```bash
actual-amazon --dry-run
actual-amazon --safety-days 14 --amazon-json data/amazon-history.json --report output/match-proposals.json
```

Safety behavior: apply skips transactions that are already split, no longer uncategorized, no longer look like an unprocessed Amazon charge descriptor, changed amount, or whose proposed split total does not equal the current Actual transaction amount.

## Amazon login and manual fetch

```bash
.venv/bin/amazon-orders login
./bin/fetch-amazon data/amazon-history.json --year 2026 --transaction-days 365 --supplement-after 2026-01-01
```

`amazon-orders` is unofficial and scrapes Amazon's consumer website. Expect MFA/CAPTCHA/login breakage sometimes. `bin/fetch-amazon` uses the Python API instead of the CLI history output so we can capture structured JSON.

## Actual inventory check

```bash
npm run actual:list
```

Use this to confirm the exact `ACTUAL_ACCOUNT_NAME` and likely Amazon payees.

## Manual dry-run matching

```bash
npm run match -- --amazon-json data/amazon-history.json
```

The output is JSON containing match proposals, proposed subtransactions, and unmatched Actual transactions. Nothing is written to Actual.

The matcher groups Amazon charge transactions by order, expands quantity lines into unit items, allocates tax/fees/discounts proportionally, and solves all charge legs for an order together so one item is not reused across multiple Actual transactions. The default fuzzy tolerance is 200 cents and can be changed with `FUZZY_MATCH_TOLERANCE_CENTS`.

## Notes

Matched split children inherit the parent Amazon payee. Existing split transactions are never reapplied by the normal command. Transactions whose notes have already been replaced with item names are ignored on future runs unless they still look like raw Amazon charge descriptors.
