# actual-amazon

Helper for reconciling Amazon purchases against Actual Budget.

By default, `actual-amazon` fetches Amazon data, matches it against unmatched Actual transactions, and applies matched updates to Actual. Multi-item charges become splits; single-item charges keep the base transaction and set its note. Use `--dry-run` to preview without modifying Actual.

Multiple Amazon accounts and multiple Actual card accounts are supported. Amazon purchases are routed to the correct Actual account using the last four digits of the credit card used for the purchase.

## Install

Node.js 22 is recommended. `better-sqlite3`, used by the Actual API, requires a supported Node version.

```bash
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

Fill in `actual-amazon.json` with your Amazon accounts and the Actual account associated with each credit card.

Do not commit `.env`, `actual-amazon.json`, or Amazon cookie files.

## Configuration

### Actual Budget

The `.env` file contains connection and matching settings:

```dotenv
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

Amazon accounts and their credit-card-to-Actual mappings are configured in `actual-amazon.json`.

Example:

```json
{
  "amazonAccounts": {
    "personal": {
      "username": "amazon-account@example.com",
      "paymentMethods": {
        "1234": "Frontier Airlines Mastercard",
        "2345": "Chase Amazon VISA"
      }
    },
    "second": {
      "username": "another-account@example.com",
      "paymentMethods": {
        "3456": "Chase Freedom VISA"
      }
    }
  }
}
```

Each Amazon account has its own persistent login session. The application automatically creates a separate cookie jar for each account under:

```text
~/.config/amazonorders/
```

For example:

```text
~/.config/amazonorders/cookies-personal.json
~/.config/amazonorders/cookies-second.json
```

#### Credit card mapping

The keys in `paymentMethods` **must be the last four digits of the credit card used for the Amazon purchase**.

For example:

```json
"1234": "Frontier Airlines Mastercard"
```

means that an Amazon purchase charged to the credit card ending in **1234** should be matched against the Actual account named `Frontier Airlines Mastercard`.

These four digits are the primary link between an Amazon purchase and the corresponding Actual credit-card account.

The value must be the **exact name of the Actual account** in your Actual budget.

For example:

```json
"1234": "Frontier Airlines Mastercard"
```

requires an Actual account named exactly:

```text
Frontier Airlines Mastercard
```

Use `npm run actual:list` to see the exact account names in the configured Actual budget.

You can configure multiple credit cards under one Amazon account:

```json
"personal": {
  "username": "amazon-account@example.com",
  "paymentMethods": {
    "1234": "Frontier Airlines Mastercard",
    "2345": "Chase Amazon VISA"
  }
}
```

You can also configure the same Actual credit-card account under multiple Amazon accounts:

```json
"personal": {
  "paymentMethods": {
    "1234": "Frontier Airlines Mastercard"
  }
},
"second": {
  "paymentMethods": {
    "1234": "Frontier Airlines Mastercard"
  }
}
```

This allows:

* Multiple Amazon accounts to sync into one Actual budget.
* One Amazon account to use multiple credit cards.
* The same Actual credit-card account to receive purchases from multiple Amazon accounts.

If Amazon reports a credit card that is not configured, the purchase is reported as an unmapped Amazon charge and is not matched to an arbitrary Actual account.

## Amazon login

Amazon authentication is handled by `amazon-orders`. Each configured Amazon account has its own persistent login session.

Log in to an account with:

```bash
./bin/amazon-login personal
```

To clear that account's stored cookies and authenticate again:

```bash
./bin/amazon-login personal --fresh
```

The program does not use cookies from an existing Firefox or Chrome profile. The `amazon-orders` session and its cookie jar are used instead.

Amazon login state is reused on subsequent runs. If Amazon rejects the stored session, the program will attempt to authenticate again.

Amazon may require MFA, JavaScript challenges, WAF challenges, or CAPTCHA checks. Playwright and Chromium are installed separately so `amazon-orders` can handle browser-based authentication challenges.

## Amazon CAPTCHA and browser challenges

Amazon may occasionally interrupt login with a JavaScript authentication challenge, an ACIC challenge, an AWS WAF challenge, or another CAPTCHA-style verification.

If you repeatedly receive an error such as:

```text
Amazon returned a JavaScript-based authentication challenge.
```

or:

```text
Browser timed out waiting for the JavaScript challenge to resolve.
```

you can configure `amazon-orders` to use its Playwright browser handlers.

Create:

```text
~/.config/amazonorders/config.yml
```

with:

```yaml
auth_forms_classes:
  - amazonorders.contrib.browser.playwright.PlaywrightAcicForm
  - amazonorders.contrib.browser.playwright.PlaywrightJSAuthForm
  - amazonorders.contrib.browser.playwright.PlaywrightManualWafForm
```

`PlaywrightAcicForm` should be registered first and handles Amazon's ACIC challenge page.

`PlaywrightJSAuthForm` provides a best-effort handler for Amazon's JavaScript bot-detection page.

`PlaywrightManualWafForm` opens a visible browser window when Amazon presents an AWS WAF challenge that requires interactive handling. This is particularly useful when running `actual-amazon` on a desktop Linux, macOS, or Windows machine where a browser window can be displayed. The challenge can be completed manually and the resulting cookies are returned to the `amazon-orders` session.

The browser configuration is used by `amazon-orders` itself; it is separate from the Amazon account configuration in this project.

The current `amazon-orders` package uses the following configuration location on Linux and macOS:

```text
~/.config/amazonorders/config.yml
```

On Windows, the package currently derives the same path from the user's home directory rather than using `%APPDATA%`, so it will normally be under:

```text
%USERPROFILE%\.config\amazonorders\config.yml
```

The `[browser]` extra is required:

```bash
pip install amazon-orders[browser]
```

and the Chromium browser must be installed:

```bash
playwright install chromium
```

The browser handlers above address JavaScript, ACIC, and WAF browser challenges. They do not automatically solve every type of image CAPTCHA. Older image-based CAPTCHA handling is a separate `amazon-orders` feature.

If Amazon presents a challenge repeatedly, clear the corresponding Amazon cookie jar and authenticate again:

```bash
./bin/amazon-login personal --fresh
```

Amazon may also increase CAPTCHA frequency after repeated failed login attempts. Using the correct credentials, allowing time between repeated attempts, and completing challenges in a normal browser can reduce repeated challenges.

## Normal run

```bash
./bin/actual-amazon
```

The command:

1. Connects to the configured Actual Budget.
2. Finds unmatched Amazon transactions across all configured Actual card accounts.
3. Finds the earliest unmatched Actual transaction and subtracts a 7-day safety window.
4. Fetches Amazon order and charge data from that date forward for every configured Amazon account.
5. Routes each Amazon charge to an Actual account using the last four digits of the credit card used for the purchase.
6. Matches Amazon charges to Actual transactions only within the mapped Actual account.
7. Writes a report to `output/match-proposals.json`.
8. Applies matched updates to Actual: split multi-item charges, set base notes for single-item charges.
9. Prints a formatted match list, unmatched transactions, unmapped Amazon charges, and skipped updates.

The date is based on the oldest currently unmatched Actual transaction. It is not a fixed one-year lookback.

Use dry-run mode to preview changes without modifying Actual:

```bash
./bin/actual-amazon --dry-run
```

Optional arguments:

```bash
./bin/actual-amazon --dry-run --safety-days 14
./bin/actual-amazon --dry-run --amazon-json data/amazon-history.json
./bin/actual-amazon --dry-run --report output/match-proposals.json
```

Safety behavior: apply skips transactions that are already split, no longer uncategorized, no longer look like an unprocessed Amazon charge, changed amount, or whose proposed split total does not equal the current Actual transaction amount.

## Amazon data and multi-account matching

Amazon data is fetched separately for each configured Amazon account and combined into one matching run.

Each charge keeps its Amazon account name and the last four digits of the credit card used for the purchase. The credit-card mapping determines which Actual account can match that charge.

For example:

```text
Amazon account: personal
Credit card: ••••1234
Actual account: Frontier Airlines Mastercard

Amazon account: personal
Credit card: ••••2345
Actual account: Chase Amazon VISA

Amazon account: second
Credit card: ••••3456
Actual account: Chase Freedom VISA
```

The four-digit value in `paymentMethods` must match the last four digits of the credit card Amazon reports for the purchase.

The matcher uses the Actual account as part of the match key so identical amounts on different cards cannot be incorrectly matched to one another.

The Actual budget is downloaded once, and all configured card accounts are processed as part of the same run. There is no need to maintain a separate copy of the project for each Amazon account or credit card.

## Manual Amazon fetch

The Python fetcher can also be run directly:

```bash
./bin/fetch-amazon data/amazon-history.json --year 2026 --transaction-days 365 --supplement-after 2026-01-01
```

For normal multi-account operation, use `./bin/actual-amazon` instead. It reads all configured Amazon profiles and produces one combined data set.

## Actual inventory check

```bash
npm run actual:list
```

Use this to confirm the exact Actual account names and likely Amazon payees.

The account names shown here must match the names used in `actual-amazon.json`.

## Manual dry-run matching

```bash
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
