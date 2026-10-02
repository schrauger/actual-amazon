# actual-amazon

Helper for reconciling Amazon purchases against Actual Budget.

By default, `actual-amazon` fetches Amazon data, matches it against unmatched Actual transactions, and applies matched updates to Actual. Multi-item charges become splits; single-item charges keep the base transaction and set its note. Use `--dry-run` to preview without modifying Actual.

Multiple Amazon accounts and multiple Actual card accounts are supported. Amazon purchases are routed to the correct Actual account using the Amazon payment method's last four digits.

## Install

Node.js 22 is recommended. `better-sqlite3`, used by the Actual API, requires a supported Node version.

```
cd ~/Code/actual-amazon

nvm install 22
nvm use 22

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

playwright install chromium

npm install

cp .env.example .env
cp actual-amazon.example.json actual-amazon.json
```

Fill in `.env` with your Actual server URL, server password, budget sync ID, and other matching settings.

Fill in `actual-amazon.json` with your Amazon accounts and the Actual account associated with each Amazon payment method.

Do not commit `.env`, `actual-amazon.json`, or Amazon cookie files.

## Configuration

### Actual Budget

The `.env` file contains connection and matching settings:

```
ACTUAL_SERVER_URL=https://actual.example.com
ACTUAL_SERVER_PASSWORD=
ACTUAL_BUDGET_SYNC_ID=
ACTUAL_BUDGET_PASSWORD=
ACTUAL_DATA_DIR=.actual-cache

ACTUAL_AMAZON_CONFIG=actual-amazon.json
AMAZON_PAYEE_MATCH=amazon
FUZZY_MATCH_TOLERANCE_CENTS=200
```

The configured Actual accounts must already exist in the same budget.

### Amazon accounts

Amazon accounts and their card-to-Actual mappings are configured in `actual-amazon.json`.

Example:

```
{
  "amazonAccounts": {
    "personal": {
      "username": "amazon-account@example.com",
      "domain": "amazon.com",
      "cookieJar": "~/.config/amazonorders/cookies-personal.json",
      "paymentMethods": {
        "2345": "Frontier Airlines Mastercard",
        "3456": "Chase Amazon VISA"
      }
    },
    "second": {
      "username": "another-account@example.com",
      "domain": "amazon.com",
      "cookieJar": "~/.config/amazonorders/cookies-second.json",
      "paymentMethods": {
        "1234": "Chase Freedom VISA"
      }
    }
  }
}
```

Each Amazon account has its own persistent cookie jar.

`paymentMethods` maps the last four digits reported by Amazon to the exact Actual account name that should receive the matching transaction.

This allows:

* Multiple Amazon accounts to sync into one Actual budget.
* One Amazon account to use multiple credit cards.
* The same Actual credit-card account to receive purchases from multiple Amazon accounts.

Unmapped payment methods are reported and are not matched to an arbitrary Actual account.

## Amazon login

Amazon authentication is handled by `amazon-orders`. Each configured Amazon account has its own persistent cookie jar.

Log in to an account with:

```
./bin/amazon-login personal
```

To clear that account's stored cookies and authenticate again:

```
./bin/amazon-login personal --fresh
```

The program does not use cookies from an existing Firefox or Chrome profile. The `amazon-orders` session and its cookie jar are used instead.

Amazon may require MFA, JavaScript challenges, or other anti-bot checks. Playwright and Chromium are installed separately so `amazon-orders` can handle browser-based authentication challenges.

Amazon login state is reused on subsequent runs. If Amazon rejects the stored session, the program will attempt to authenticate again.

## Normal run

```
./bin/actual-amazon
```

The command:

1. Connects to the configured Actual Budget.
2. Finds unmatched Amazon transactions across all configured Actual card accounts.
3. Finds the earliest unmatched Actual transaction and subtracts a 7-day safety window.
4. Fetches Amazon order and charge data from that date forward for every configured Amazon account.
5. Routes each Amazon charge to an Actual account using its payment method last four digits.
6. Matches Amazon charges to Actual transactions only within the mapped Actual account.
7. Writes a report to `output/match-proposals.json`.
8. Applies matched updates to Actual: split multi-item charges, set base notes for single-item charges.
9. Prints a formatted match list, unmatched transactions, unmapped Amazon charges, and skipped updates.

The date is based on the oldest currently unmatched Actual transaction. It is not a fixed one-year lookback.

Use dry-run mode to preview changes without modifying Actual:

```
./bin/actual-amazon --dry-run
```

Optional arguments:

```
./bin/actual-amazon --dry-run --safety-days 14
./bin/actual-amazon --dry-run --amazon-json data/amazon-history.json
./bin/actual-amazon --dry-run --report output/match-proposals.json
```

Safety behavior: apply skips transactions that are already split, no longer uncategorized, no longer look like an unprocessed Amazon charge, changed amount, or whose proposed split total does not equal the current Actual transaction amount.

## Amazon data and multi-account matching

Amazon data is fetched separately for each configured Amazon account and combined into one matching run.

Each charge keeps its Amazon account name, payment method, and payment method last four digits. The payment method mapping determines which Actual account can match that charge.

For example:

```
Amazon account: personal
Card: ••••2345
Actual account: Frontier Airlines Mastercard

Amazon account: personal
Card: ••••3456
Actual account: Chase Amazon VISA

Amazon account: second
Card: ••••1234
Actual account: Chase Freedom VISA
```

The matcher uses the Actual account as part of the match key so identical amounts on different cards cannot be incorrectly matched to one another.

## Manual Amazon fetch

The Python fetcher can also be run directly:

```
./bin/fetch-amazon data/amazon-history.json --year 2026 --transaction-days 365 --supplement-after 2026-01-01
```

For normal multi-account operation, use `./bin/actual-amazon` instead. It reads all configured Amazon profiles and produces one combined data set.

## Actual inventory check

```
npm run actual:list
```

Use this to confirm the exact Actual account names and likely Amazon payees.

The account names shown here must match the names used in `actual-amazon.json`.

## Manual dry-run matching

```
npm run match -- --amazon-json data/amazon-history.json
```

The output is JSON containing match proposals, proposed subtransactions, unmapped Amazon charges, and unmatched Actual transactions. Nothing is written to Actual.

The matcher groups Amazon charge transactions by Amazon account and order, expands quantity lines into unit items, allocates tax/fees/discounts proportionally, and solves all charge legs for an order together so one item is not reused across multiple Actual transactions. The default fuzzy tolerance is 200 cents and can be changed with `FUZZY_MATCH_TOLERANCE_CENTS`.

## Notes

Matched split children inherit the parent Amazon payee.

Existing split transactions are never reapplied by the normal command.

Transactions whose notes have already been replaced with item names are ignored on future runs unless they still look like raw Amazon charge descriptors.

Amazon gift cards, rewards, and other non-card payment methods are not mapped to an Actual card account. Card charges from orders containing those payment methods are still handled when they can be resolved unambiguously.

Amazon authentication depends on an unofficial scraper of Amazon's consumer website. MFA, CAPTCHA, JavaScript challenges, or changes to Amazon's login pages may require additional authentication or code changes.
