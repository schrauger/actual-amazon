#!/usr/bin/env python3

import argparse
import json
import os
import sys
from dataclasses import asdict, is_dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any

from amazonorders.conf import AmazonOrdersConfig
from amazonorders.exception import AmazonOrdersAuthRedirectError
from amazonorders.orders import AmazonOrders
from amazonorders.session import AmazonSession
from amazonorders.transactions import AmazonTransactions
from pathlib import Path

def main() -> None:
    args = parse_args()
    config = load_config(args.config)

    account_names = select_accounts(config, args.amazon_account)

    if args.login:
        login_accounts(config, account_names, args)
        return

    results = {}

    for account_name in account_names:
        profile = config["amazonAccounts"][account_name]
        print()
        print(f"Fetching Amazon account: {account_name}")

        orders, transactions = fetch_account(account_name, profile, args)

        results[account_name] = {
            "orders": [to_plain_value(order) for order in orders],
            "transactions": [to_plain_value(transaction) for transaction in transactions],
        }

    payload = {
        "version": 2,
        "accounts": results,
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(payload, indent=2, sort_keys=True, default=str)
    )

    print(f"Wrote {args.output}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Fetch Amazon orders and transactions for multiple accounts."
    )

    parser.add_argument(
        "--config",
        type=Path,
        default=Path(
            os.environ.get(
                "ACTUAL_AMAZON_CONFIG",
                "actual-amazon.json",
            )
        ),
    )

    parser.add_argument(
        "--amazon-account",
        action="append",
        help="Amazon account profile name. May be specified more than once. Defaults to all.",
    )

    parser.add_argument(
        "--output",
        type=Path,
        default=Path("data/amazon-history.json"),
    )

    parser.add_argument("--year", type=int)
    parser.add_argument("--time-filter", choices=["last30", "months-3"])
    parser.add_argument("--transaction-days", type=int, default=365)
    parser.add_argument("--start-date")
    parser.add_argument("--domain")
    parser.add_argument("--full-details", action="store_true", default=True)

    parser.add_argument(
        "--supplement-missing-orders",
        action="store_true",
        default=True,
    )

    parser.add_argument(
        "--no-supplement-missing-orders",
        action="store_false",
        dest="supplement_missing_orders",
    )

    parser.add_argument("--supplement-after")
    parser.add_argument("--debug", action="store_true")

    parser.add_argument(
        "--login",
        action="store_true",
        help="Authenticate the selected Amazon account profiles.",
    )

    parser.add_argument(
        "--fresh",
        action="store_true",
        help="Delete the selected account cookie jars before login.",
    )

    return parser.parse_args()


def load_config(path: Path) -> dict[str, Any]:
    try:
        raw = path.expanduser().read_text()
        config = json.loads(raw)
    except Exception as error:
        raise RuntimeError(f"Unable to read Amazon config {path}: {error}") from error

    accounts = config.get("amazonAccounts")

    if not isinstance(accounts, dict) or not accounts:
        raise RuntimeError(
            "Amazon config must contain a non-empty amazonAccounts object."
        )

    return config


def select_accounts(
    config: dict[str, Any],
    requested: list[str] | None,
) -> list[str]:
    available = config["amazonAccounts"]

    if not requested:
        return list(available)

    unknown = [name for name in requested if name not in available]

    if unknown:
        raise RuntimeError(
            f"Unknown Amazon account(s): {', '.join(unknown)}"
        )

    return requested


def get_cookie_jar_path(account_name: str) -> Path:
    cookie_dir = (
        Path.home()
        / ".config"
        / "amazonorders"
    )

    cookie_dir.mkdir(
        parents=True,
        exist_ok=True,
    )

    return cookie_dir / f"cookies-{account_name}.json"

def create_session(
    account_name: str,
    profile: dict[str, Any],
    args: argparse.Namespace,
) -> AmazonSession:
    cookie_jar = get_cookie_jar_path(
        account_name
    )

    config = AmazonOrdersConfig(
        data={
            "cookie_jar_path": str(cookie_jar),
        }
    )

    session = AmazonSession(
        username=profile.get("username"),
        config=config,
        debug=args.debug,
    )

    if session.auth_cookies_stored():
        session.is_authenticated = True

    return session

def login_accounts(
    config: dict[str, Any],
    account_names: list[str],
    args: argparse.Namespace,
) -> None:
    for account_name in account_names:
        profile = config["amazonAccounts"][account_name]
        cookie_jar = get_cookie_jar_path(account_name)

        if args.fresh:
            cookie_jar.unlink(
                missing_ok=True
            )
            print(
                f"Removed cookie jar: {cookie_jar}"
            )

        print()
        print(
            f"Logging into Amazon account: "
            f"{account_name}"
        )
        print(
            f"Username: {profile['username']}"
        )

        session = create_session(
            account_name,
            profile,
            args,
        )

        session.login()

        print(
            f"Login successful; cookies stored in "
            f"{cookie_jar}"
        )

def fetch_account(
    account_name: str,
    profile: dict[str, Any],
    args: argparse.Namespace,
) -> tuple[list[Any], list[Any]]:
    session = create_session(account_name, profile, args)

    if not session.is_authenticated:
        print("No stored Amazon authentication; starting login.")
        session.login()

    try:
        return fetch_account_data(session, args)
    except AmazonOrdersAuthRedirectError:
        print(
            "Amazon rejected the stored session; re-authenticating.",
            file=sys.stderr,
        )

        session.login()
        return fetch_account_data(session, args)


def fetch_account_data(
    session: AmazonSession,
    args: argparse.Namespace,
) -> tuple[list[Any], list[Any]]:
    orders_client = AmazonOrders(session)
    transactions_client = AmazonTransactions(session)

    orders = fetch_order_history(orders_client, args)
    transactions = transactions_client.get_transactions(
        days=get_transaction_days(args),
    )

    if args.supplement_missing_orders:
        orders.extend(
            fetch_missing_transaction_orders(
                orders_client,
                orders,
                transactions,
                args.supplement_after,
            )
        )

    return orders, transactions


def fetch_order_history(
    orders_client: AmazonOrders,
    args: argparse.Namespace,
) -> list[Any]:
    if args.time_filter:
        return orders_client.get_order_history(
            full_details=args.full_details,
            time_filter=args.time_filter,
        )

    years = get_order_years(args)
    orders = []
    seen_order_ids = set()

    for year in years:
        print(f"Fetching Amazon order history for {year}")

        for order in orders_client.get_order_history(
            year=year,
            full_details=args.full_details,
        ):
            order_id = get_field(order, "order_number")

            if order_id in seen_order_ids:
                continue

            orders.append(order)
            seen_order_ids.add(order_id)

    return orders


def get_order_years(args: argparse.Namespace) -> list[int]:
    if args.year:
        return [args.year]

    if args.start_date:
        start_date = parse_iso_date(args.start_date)
        current_year = date.today().year
        return list(range(start_date.year, current_year + 1))

    return [date.today().year]


def get_transaction_days(args: argparse.Namespace) -> int:
    if not args.start_date:
        return args.transaction_days

    start_date = parse_iso_date(args.start_date)

    return max(
        (date.today() - start_date).days + 1,
        1,
    )


def parse_iso_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def fetch_missing_transaction_orders(
    orders_client: AmazonOrders,
    orders: list[Any],
    transactions: list[Any],
    supplement_after: str | None,
) -> list[Any]:
    known_order_ids = {
        get_field(order, "order_number")
        for order in orders
    }

    missing_order_ids = []

    for transaction in transactions:
        order_id = get_field(transaction, "order_number")
        completed_date = get_field(transaction, "completed_date")

        completed_date_text = (
            completed_date.isoformat()
            if hasattr(completed_date, "isoformat")
            else completed_date
        )

        if not order_id or order_id in known_order_ids:
            continue

        if (
            supplement_after
            and completed_date_text
            and completed_date_text < supplement_after
        ):
            continue

        missing_order_ids.append(order_id)
        known_order_ids.add(order_id)

    supplemented_orders = []

    for order_id in missing_order_ids:
        try:
            print(f"Fetching missing order details for {order_id}")
            supplemented_orders.append(
                orders_client.get_order(order_id)
            )
        except Exception as error:
            print(
                f"Could not fetch missing order {order_id}: {error}",
                file=sys.stderr,
            )

    return supplemented_orders


def get_field(value: Any, field_name: str) -> Any:
    if isinstance(value, dict):
        return value.get(field_name)

    return getattr(value, field_name, None)


def to_plain_value(value: Any) -> Any:
    if is_dataclass(value):
        return to_plain_value(asdict(value))

    if isinstance(value, dict):
        return {
            str(key): to_plain_value(child)
            for key, child in value.items()
        }

    if isinstance(value, (list, tuple, set)):
        return [
            to_plain_value(child)
            for child in value
        ]

    if hasattr(value, "__dict__"):
        public_values = {
            key: child
            for key, child in vars(value).items()
            if not key.startswith("_")
            and key not in {"soup", "parsed", "config"}
        }

        return to_plain_value(public_values)

    return value


if __name__ == "__main__":
    main()
