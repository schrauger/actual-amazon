import 'dotenv/config';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as api from '@actual-app/api';
import {
  getConfiguredActualAccountNames,
  getMappedActualAccountName,
  loadAmazonConfig,
} from './config.js';

const MATCH_DATE_WINDOW_DAYS = 7;
const DEFAULT_FUZZY_MATCH_TOLERANCE_CENTS = 200;

async function main() {
  const command = process.argv[2];

  if (command === 'list') {
    await withActual(printActualInventory);
    return;
  }

  if (command === 'match') {
    const amazonFile = getRequiredArgument('--amazon-json');
    await withActual(() => matchAmazonOrdersToActual(amazonFile));
    return;
  }

  if (command === 'run') {
    printSection('actual-amazon');
    console.log('Connecting to Actual...');
    await withActual(runPipeline);
    return;
  }

  printUsage();
}

async function withActual(action) {
  validateActualEnvironment();

  const dataDir = process.env.ACTUAL_DATA_DIR ?? '.actual-cache';
  await fs.mkdir(dataDir, { recursive: true });

  await api.init({
    serverURL: normalizeServerUrl(process.env.ACTUAL_SERVER_URL),
    password: process.env.ACTUAL_SERVER_PASSWORD,
    dataDir,
    verbose: false,
  });

  try {
    await api.downloadBudget(process.env.ACTUAL_BUDGET_SYNC_ID, {
      password: process.env.ACTUAL_BUDGET_PASSWORD,
    });
    await action();
  } finally {
    await api.shutdown();
  }
}

async function printActualInventory() {
  const [accounts, payees, categoryGroups] = await Promise.all([
    api.getAccounts(),
    api.getPayees(),
    api.getCategoryGroups({ hidden: false }),
  ]);

  console.log('Accounts');
  for (const account of accounts) {
    console.log(`- ${account.name} (${account.id})`);
  }

  console.log('\nLikely Amazon payees');
  const amazonPayees = payees.filter((payee) => payee.name.toLowerCase().includes('amazon'));
  for (const payee of amazonPayees) {
    console.log(`- ${payee.name} (${payee.id})`);
  }

  console.log('\nCategories');
  for (const group of categoryGroups) {
    console.log(`- ${group.name}`);
    for (const category of group.categories ?? []) {
      console.log(`  - ${category.name} (${category.id})`);
    }
  }
}

async function matchAmazonOrdersToActual(amazonFile) {
  const config = await loadAmazonConfig();
  const context =
    await getActualAmazonContext(config);

  const amazonCharges =
    await readAmazonCharges(
      amazonFile,
      context,
    );
  const report = buildMatchReport(context, amazonCharges);
  console.log(JSON.stringify(report, null, 2));
}

async function runPipeline() {
  const config = await loadAmazonConfig();
  const amazonFile =
    getOptionalArgument('--amazon-json') ??
    'data/amazon-history.json';
  const reportFile =
    getOptionalArgument('--report') ??
    'output/match-proposals.json';
  const safetyDays =
    Number(getOptionalArgument('--safety-days') ?? 7);
  const isDryRun = hasFlag('--dry-run');

  const context = await getActualAmazonContext(config);

  if (context.candidates.length === 0) {
    console.log('No unmatched Amazon transactions found.');
    return;
  }

  const startDate = getSafetyStartDate(
    context.candidates,
    safetyDays,
  );

  printRunHeader({
    amazonAccountCount:
      Object.keys(config.amazonAccounts).length,
    actualAccountNames:
      context.accounts.map((account) => account.name),
    unmatchedCount:
      context.candidates.length,
    startDate,
    isDryRun,
  });

  await fetchAmazonData({
    amazonFile,
    startDate,
    configPath: config.configPath,
  });

  const amazonCharges =
    await readAmazonCharges(
      amazonFile,
      context,
    );

  const report =
    buildMatchReport(
      context,
      amazonCharges,
    );

  await writeJsonFile(
    reportFile,
    report,
  );

  printPipelineSummary(
    report,
    reportFile,
    { isDryRun },
  );

  printMatchedProposals(
    report.proposals,
    { isDryRun },
  );

  printUnmatchedTransactions(
    report.unmatchedActualTransactions,
  );

  if (isDryRun) {
    return;
  }

  const applyResult =
    await applyMatchProposals(
      report.proposals,
    );

  await api.sync();

  printApplySummary(applyResult);
}

async function getActualAmazonContext(config) {
  const configuredNames = getConfiguredActualAccountNames(config);
  const accounts = await api.getAccounts();

  const accountsByName = new Map();

  for (const accountName of configuredNames) {
    const account = accounts.find(
      (candidate) => candidate.name === accountName,
    );

    if (!account) {
      throw new Error(
        `Actual account not found: ${accountName}`,
      );
    }

    accountsByName.set(accountName, account);
  }

  const accountContexts = await Promise.all(
    [...accountsByName.values()].map(async (account) => {
      const transactions = await api.getTransactions(
        account.id,
        '1900-01-01',
        '2100-12-31',
      );

      const accountTransactions = transactions.map((transaction) => ({
        ...transaction,
        actualAccountId: account.id,
        actualAccountName: account.name,
      }));

      return {
        account,
        transactions: accountTransactions,
        amazonAccountTransactions:
          accountTransactions.filter(isAmazonAccountTransaction),
        candidates:
          accountTransactions.filter(isUncategorizedTransaction),
      };
    }),
  );

  return {
    config,
    accountsByName,
    accounts: accountContexts.map((context) => context.account),
    accountContexts,
    amazonAccountTransactions: accountContexts.flatMap(
      (context) => context.amazonAccountTransactions,
    ),
    candidates: accountContexts.flatMap(
      (context) => context.candidates,
    ),
  };
}

function buildMatchReport(
  context,
  amazonCharges,
) {
  const proposals =
    buildOrderAllocationProposals(
      amazonCharges,
      context.amazonAccountTransactions,
      context.candidates,
    );

  const matchedActualTransactionIds =
    new Set(
      proposals.map(
        (proposal) =>
          proposal.actualTransaction.id,
      ),
    );

  const unmatchedActualTransactions =
    context.candidates
      .filter(
        (transaction) =>
          !matchedActualTransactionIds.has(
            transaction.id,
          ),
      )
      .map(describeActualTransaction);

  return {
    actualAccounts: context.accounts.map(
      (account) => account.name,
    ),

    unmappedAmazonCharges:
      amazonCharges
        .filter(
          (charge) =>
            !charge.actualAccountId &&
            !isNonActualPaymentMethod(
              charge.paymentMethod,
            ),
        )
        .map((charge) => ({
          amazonAccount:
            charge.amazonAccount,
          orderId:
            charge.orderId,
          date:
            charge.date,
          amount:
            charge.total,
          paymentMethod:
            charge.paymentMethod,
          paymentMethodLast4:
            charge.paymentMethodLast4,
        })),

    fuzzyMatchToleranceCents:
      getFuzzyMatchToleranceCents(),

    amazonChargeCount:
      amazonCharges.length,

    unmatchedActualTransactionCount:
      context.candidates.length,

    proposalCount:
      proposals.length,

    stillUnmatchedActualTransactionCount:
      unmatchedActualTransactions.length,

    unmatchedActualTransactions,

    proposals,
  };
}

function isNonActualPaymentMethod(paymentMethod) {
  return /gift|reward|points/i.test(
    paymentMethod ?? '',
  );
}

function getSafetyStartDate(transactions, safetyDays) {
  const earliestDate = transactions
    .map((transaction) => transaction.date)
    .filter(Boolean)
    .sort()[0];

  if (!earliestDate) {
    throw new Error('Could not determine earliest unmatched transaction date.');
  }

  const startDate = new Date(`${earliestDate}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - safetyDays);
  return startDate.toISOString().slice(0, 10);
}

async function fetchAmazonData({ amazonFile, startDate, configPath }) {
  await fs.mkdir(path.dirname(path.resolve(amazonFile)), {
    recursive: true,
  });

  await runProcess('.venv/bin/python', [
    'src/fetch_amazon.py',
    '--config',
    configPath,
    '--output',
    amazonFile,
    '--start-date',
    startDate,
    '--supplement-after',
    startDate,
  ]);
}

async function runProcess(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: 'inherit',
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function printRunHeader({
  amazonAccountCount,
  actualAccountNames,
  unmatchedCount,
  startDate,
  isDryRun,
}) {
  printSection('Run settings');

  console.log(
    `Mode: ${isDryRun ? 'dry run' : 'apply matched splits'}`,
  );

  console.log(
    `Amazon accounts: ${amazonAccountCount}`,
  );

  console.log(
    `Actual accounts: ${actualAccountNames.join(', ')}`,
  );

  console.log(
    `Unmatched Amazon transactions: ${unmatchedCount}`,
  );

  console.log(
    `Amazon fetch start: ${startDate}`,
  );
}

function printPipelineSummary(
  report,
  reportFile,
  { isDryRun },
) {
  printSection(
    isDryRun
      ? 'Match preview'
      : 'Match results',
  );

  printKeyValueRows([
    [
      'Actual accounts',
      report.actualAccounts.join(', '),
    ],
    [
      'Amazon charges fetched',
      report.amazonChargeCount,
    ],
    [
      'Actual transactions examined',
      report.unmatchedActualTransactionCount,
    ],
    [
      'Matched proposals',
      report.proposalCount,
    ],
    [
      'Still unmatched',
      report.stillUnmatchedActualTransactionCount,
    ],
    [
      'Unmapped Amazon charges',
      report.unmappedAmazonCharges.length,
    ],
    [
      'Report file',
      reportFile,
    ],
  ]);
}

function printMatchedProposals(proposals, { isDryRun }) {
  printSection(isDryRun ? 'Transactions that would be updated' : 'Transactions to update');

  if (proposals.length === 0) {
    console.log('No matched transactions.');
    return;
  }

  proposals.forEach((proposal, index) => {
    const splitTotal = sumNumbers(proposal.proposedSubtransactions.map((split) => split.amount));
    const actionDescription = getProposalActionDescription(proposal);
    console.log(`${String(index + 1).padStart(2)}. ${proposal.actualTransaction.date}  ${formatAmount(proposal.actualTransaction.amount).padStart(9)}  ${proposal.orderId}`);
    console.log(`    ${proposal.confidence} · ${actionDescription} · total ${formatAmount(splitTotal)}`);

    proposal.proposedSubtransactions.forEach((split, splitIndex) => {
      const branch = splitIndex === proposal.proposedSubtransactions.length - 1 ? '└─' : '├─';
      console.log(`    ${branch} ${formatAmount(split.amount).padStart(9)}  ${truncateText(split.notes, 100)}`);
    });
  });
}

function printUnmatchedTransactions(transactions) {
  if (transactions.length === 0) {
    return;
  }

  printSection('Still unmatched');
  for (const transaction of transactions) {
    console.log(`  ${transaction.date}  ${formatAmount(transaction.amount).padStart(9)}  ${transaction.notes ?? ''}`);
  }
}

function printSection(title) {
  console.log(`\n${title}`);
  console.log('─'.repeat(title.length));
}

function printKeyValueRows(rows) {
  const labelWidth = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    console.log(`${label.padEnd(labelWidth)}  ${value}`);
  }
}

function formatAmount(amount) {
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${(Math.abs(amount) / 100).toFixed(2)}`;
}

function truncateText(text, maxLength) {
  if (!text || text.length <= maxLength) {
    return text ?? '';
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function getProposalActionDescription(proposal) {
  const splitCount = proposal.proposedSubtransactions.length;
  if (splitCount === 1) {
    return 'set base note';
  }

  return `${splitCount} splits`;
}

async function applyMatchProposals(proposals) {
  const result = {
    applied: [],
    skipped: [],
  };

  printSection('Applying updates');

  for (const proposal of proposals) {
    const currentTransaction = await loadCurrentTransaction(proposal);
    const skipReason = getApplySkipReason(proposal, currentTransaction);
    if (skipReason) {
      result.skipped.push({
        id: proposal.actualTransaction.id,
        date: proposal.actualTransaction.date,
        amount: proposal.actualTransaction.amount,
        reason: skipReason,
      });
      console.log(`skip   ${proposal.actualTransaction.date}  ${formatAmount(proposal.actualTransaction.amount).padStart(9)}  ${proposal.orderId} · ${skipReason}`);
      continue;
    }

    const action = await applyProposal(proposal, currentTransaction);
    console.log(`apply  ${proposal.actualTransaction.date}  ${formatAmount(proposal.actualTransaction.amount).padStart(9)}  ${proposal.orderId} · ${action}`);
    result.applied.push({
      id: proposal.actualTransaction.id,
      date: proposal.actualTransaction.date,
      amount: proposal.actualTransaction.amount,
      orderId: proposal.orderId,
      action,
      splitCount: proposal.proposedSubtransactions.length,
    });
  }

  return result;
}

async function loadCurrentTransaction(proposal) {
  const accountId = proposal.proposedSubtransactions[0]?.account;
  if (!accountId) {
    return null;
  }

  const transactions = await api.getTransactions(
    accountId,
    proposal.actualTransaction.date,
    proposal.actualTransaction.date,
  );
  return transactions.find((transaction) => transaction.id === proposal.actualTransaction.id) ?? null;
}

function getApplySkipReason(proposal, currentTransaction) {
  if (!currentTransaction) {
    return 'transaction not found';
  }

  if (currentTransaction.is_parent || currentTransaction.is_child) {
    return 'transaction is already split';
  }

  if (currentTransaction.category) {
    return 'transaction is no longer uncategorized';
  }

  if (!isAmazonAccountTransaction(currentTransaction)) {
    return 'transaction no longer looks like Amazon';
  }

  if (currentTransaction.amount !== proposal.actualTransaction.amount) {
    return 'transaction amount changed';
  }

  if (sumNumbers(proposal.proposedSubtransactions.map((split) => split.amount)) !== currentTransaction.amount) {
    return 'proposed split total does not equal transaction amount';
  }

  return null;
}

async function applyProposal(proposal, currentTransaction) {
  if (proposal.proposedSubtransactions.length === 1) {
    await applySingleItemProposal(proposal, currentTransaction);
    return 'set base note';
  }

  await applySplitProposal(proposal, currentTransaction);
  return `${proposal.proposedSubtransactions.length} splits`;
}

async function applySingleItemProposal(proposal, currentTransaction) {
  const [singleItem] = proposal.proposedSubtransactions;
  await api.updateTransaction(currentTransaction.id, {
    account: currentTransaction.account,
    date: currentTransaction.date,
    amount: currentTransaction.amount,
    category: currentTransaction.category,
    payee: currentTransaction.payee,
    imported_payee: currentTransaction.imported_payee,
    imported_id: currentTransaction.imported_id,
    notes: singleItem.notes,
    cleared: currentTransaction.cleared,
    is_parent: false,
  });
}

async function applySplitProposal(proposal, currentTransaction) {
  await api.updateTransaction(currentTransaction.id, {
    account: currentTransaction.account,
    date: currentTransaction.date,
    amount: currentTransaction.amount,
    category: currentTransaction.category,
    payee: currentTransaction.payee,
    imported_payee: currentTransaction.imported_payee,
    imported_id: currentTransaction.imported_id,
    notes: currentTransaction.notes,
    cleared: currentTransaction.cleared,
    is_parent: true,
    subtransactions: proposal.proposedSubtransactions.map((split) => ({
      amount: split.amount,
      account: currentTransaction.account,
      date: currentTransaction.date,
      parent_id: currentTransaction.id,
      is_child: true,
      is_parent: false,
      payee: currentTransaction.payee,
      category: split.category ?? null,
      notes: split.notes,
    })),
  });
}

function printApplySummary(result) {
  printSection('Actual update complete');
  printKeyValueRows([
    ['Applied', result.applied.length],
    ['Skipped', result.skipped.length],
  ]);

  if (result.skipped.length > 0) {
    console.log('\nSkipped transactions:');
    for (const skipped of result.skipped) {
      console.log(`  ${skipped.date}  ${formatAmount(skipped.amount).padStart(9)}  ${skipped.id} · ${skipped.reason}`);
    }
  }
}
async function readAmazonCharges(amazonFile, context) {
  const rawContent = await fs.readFile(
    path.resolve(amazonFile),
    'utf8',
  );

  const parsed = JSON.parse(rawContent);

  const accountEntries = parsed.accounts
    ? Object.entries(parsed.accounts)
    : getLegacyAmazonAccountEntries(parsed, context);

  return accountEntries.flatMap(
    ([amazonAccountName, accountData]) => {
      const orders = accountData.orders ?? [];
      const transactions = accountData.transactions ?? [];

      const ordersById = new Map(
        orders.map((order) => [
          getAmazonOrderId(order),
          normalizeAmazonOrder(order),
        ]),
      );

      return transactions
        .map((transaction) => normalizeAmazonCharge(
          transaction,
          ordersById,
          amazonAccountName,
          context,
        ))
        .filter(
          (charge) =>
            charge.order &&
            charge.total !== null,
        );
    },
  );
}

function getLegacyAmazonAccountEntries(parsed, context) {
  const amazonAccountNames = Object.keys(
    context.config.amazonAccounts,
  );

  if (amazonAccountNames.length !== 1) {
    throw new Error(
      'The supplied Amazon JSON uses the old single-account format. ' +
      'Regenerate it with bin/fetch-amazon now that multiple Amazon accounts are configured.',
    );
  }

  const orders = Array.isArray(parsed)
    ? parsed
    : parsed.orders ?? [];

  const transactions = parsed.transactions ?? [];

  return [[
    amazonAccountNames[0],
    {
      orders,
      transactions,
    },
  ]];
}

function normalizeAmazonOrder(order) {
  const orderId = getAmazonOrderId(order);
  const total = parseCurrencyAmount(order.grand_total ?? order.grandtotal ?? order.total ?? order.amount);
  const items = normalizeAmazonItems(order.items ?? order.lineItems ?? []);

  return {
    orderId,
    date: order.order_placed_date ?? order.date ?? order.orderdate ?? order.orderDate,
    total,
    items,
    raw: order,
  };
}

function normalizeAmazonItems(items) {
  return items.flatMap((item, lineIndex) => expandAmazonItem(item, lineIndex));
}

function expandAmazonItem(item, lineIndex) {
  const quantity = parseQuantity(item.quantity);
  const title = item.title ?? item.name ?? item.productTitle ?? item.description ?? 'Amazon item';
  const totalAmount = parseCurrencyAmount(item.total ?? item.amount ?? calculateLineItemPrice(item));
  if (totalAmount === null) {
    return [];
  }

  const unitAmounts = allocateAmountAcrossQuantity(totalAmount, quantity);
  return unitAmounts.map((amount, unitIndex) => ({
    title,
    amount,
    sourceLineId: String(lineIndex),
    sourceQuantity: quantity,
    unitIndex,
  }));
}

function normalizeAmazonCharge(
  transaction,
  ordersById,
  amazonAccountName,
  context,
) {
  const orderId = getAmazonOrderId(transaction);
  const order = ordersById.get(orderId);

  const paymentMethodLast4 =
    getPaymentMethodLast4(transaction, order);

  const actualAccountName =
    getMappedActualAccountName(
      context.config,
      amazonAccountName,
      paymentMethodLast4,
    );

  const actualAccount = actualAccountName
    ? context.accountsByName.get(actualAccountName)
    : null;

  return {
    amazonAccount: amazonAccountName,
    orderId,
    date: transaction.completed_date,
    total: parseCurrencyAmount(
      transaction.grand_total ??
      transaction.total ??
      transaction.amount,
    ),
    paymentMethod: transaction.payment_method,
    paymentMethodLast4,
    actualAccountId: actualAccount?.id ?? null,
    actualAccountName: actualAccount?.name ?? null,
    seller: transaction.seller,
    order,
    raw: transaction,
  };
}

function getPaymentMethodLast4(transaction, order) {
  const directValue =
    transaction.payment_method_last_4 ??
    transaction.paymentMethodLast4 ??
    order?.payment_method_last_4 ??
    order?.paymentMethodLast4;

  if (directValue) {
    return normalizeLast4(directValue);
  }

  const paymentMethod =
    transaction.payment_method ??
    transaction.paymentMethod ??
    order?.payment_method ??
    order?.paymentMethod;

  if (!paymentMethod) {
    return null;
  }

  const match = String(paymentMethod).match(/(\d{4})\D*$/);

  return match ? match[1] : null;
}

function normalizeLast4(value) {
  const digits = String(value).replace(/\D/g, '');
  return digits.length >= 4
    ? digits.slice(-4)
    : null;
}

function getAmazonOrderId(value) {
  return value.order_number ?? value.ordernumber ?? value.orderNumber ?? value.order_id ?? value.orderId ?? value.id;
}

function buildOrderAllocationProposals(
  charges,
  actualTransactions,
  uncategorizedTransactions,
) {
  const uncategorizedTransactionIds =
    new Set(
      uncategorizedTransactions.map(
        (transaction) => transaction.id,
      ),
    );

  const reservedTransactionIds = new Set();

  const chargesByOrder = groupBy(
    charges.filter(
      (charge) =>
        charge.total !== null &&
        charge.order,
    ),
    (charge) =>
      `${charge.amazonAccount}:${charge.orderId}`,
  );

  return [...chargesByOrder.values()].flatMap(
    (orderCharges) => {
      const purchaseCharges = orderCharges.filter(
        (charge) =>
          !charge.raw.is_refund &&
          charge.raw.grand_total < 0,
      );

      if (purchaseCharges.length === 0) {
        return [];
      }

      const order = purchaseCharges[0].order;

      const orderReservedTransactionIds =
        new Set(reservedTransactionIds);

      const chargeTargets = purchaseCharges.map(
        (charge) => {
          const actualTransaction =
            findActualTransactionForCharge(
              charge,
              actualTransactions,
              orderReservedTransactionIds,
            );

          if (actualTransaction) {
            orderReservedTransactionIds.add(
              actualTransaction.id,
            );
          }

          return {
            charge,
            amount: charge.total,
            actualTransaction,
          };
        },
      );

      if (
        !chargeTargets.some(
          (target) => target.actualTransaction,
        )
      ) {
        return [];
      }

      const allocation = solveOrderAllocation(
        order,
        chargeTargets.map(
          (target) => target.amount,
        ),
      );

      let proposals;

      if (allocation) {
        proposals = chargeTargets.flatMap(
          (target, index) =>
            buildAllocationProposal({
              confidence: 'order-level-allocation',
              order,
              target,
              matchedItems: allocation[index],
              uncategorizedTransactionIds,
            }),
        );
      } else {
        proposals =
          buildPaymentSplitFallbackProposals(
            order,
            chargeTargets,
            uncategorizedTransactionIds,
          );
      }

      for (const proposal of proposals) {
        reservedTransactionIds.add(
          proposal.actualTransaction.id,
        );
      }

      return proposals;
    },
  );
}

function buildPaymentSplitFallbackProposals(
  order,
  chargeTargets,
  uncategorizedTransactionIds,
) {
  if (!hasNonActualPaymentSplit(chargeTargets)) {
    return [];
  }

  const actualTargets = chargeTargets.filter(
    (target) => target.actualTransaction,
  );

  if (actualTargets.length === 0) {
    return [];
  }

  const allocation = solveOrderAllocation(
    order,
    actualTargets.map(
      (target) => target.amount,
    ),
  );

  if (!allocation) {
    return [];
  }

  return actualTargets.flatMap(
    (target, index) =>
      buildAllocationProposal({
        confidence:
          'payment-split-order-allocation',
        order,
        target,
        matchedItems: allocation[index],
        uncategorizedTransactionIds,
      }),
  );
}

function hasNonActualPaymentSplit(chargeTargets) {
  return chargeTargets.some((target) => (
    !target.actualTransaction && /gift|reward|points/i.test(target.charge.paymentMethod ?? '')
  ));
}

function buildAllocationProposal({
  confidence,
  order,
  target,
  matchedItems,
  uncategorizedTransactionIds,
}) {
  if (
    !target.actualTransaction ||
    !uncategorizedTransactionIds.has(
      target.actualTransaction.id,
    )
  ) {
    return [];
  }

  return [{
    confidence,
    amazonAccount: target.charge.amazonAccount,
    orderId: target.charge.orderId,
    orderDate: order.date,
    amazonChargeDate: target.charge.date,
    amazonPaymentMethod:
      target.charge.paymentMethod,
    amazonPaymentMethodLast4:
      target.charge.paymentMethodLast4,
    amazonSeller: target.charge.seller,
    actualAccountName:
      target.charge.actualAccountName,
    actualTransaction:
      describeActualTransaction(
        target.actualTransaction,
      ),
    proposedSubtransactions:
      buildSubtransactions(
        matchedItems,
        target.actualTransaction,
      ),
  }];
}

function findActualTransactionForCharge(
  charge,
  actualTransactions,
  reservedTransactionIds,
) {
  if (!charge.actualAccountId) {
    return null;
  }

  return actualTransactions.find((transaction) => (
    transaction.actualAccountId === charge.actualAccountId &&
    !reservedTransactionIds.has(transaction.id) &&
    Math.abs(transaction.amount) === charge.total &&
    areDatesNear(transaction.date, charge.date)
  )) ?? null;
}

function solveOrderAllocation(order, chargeAmounts) {
  const items = order.items.filter((item) => item.amount !== null);
  if (items.length === 0 || items.length > 18) {
    return null;
  }

  const adjustedItems = allocateItemAmountsToTransactionTotal(items, sumNumbers(chargeAmounts))
    .map((amount, index) => ({ ...items[index], amount }));

  return assignItemsToCharges(adjustedItems, chargeAmounts, 0, new Set());
}

function assignItemsToCharges(items, chargeAmounts, chargeIndex, usedIndexes) {
  if (chargeIndex === chargeAmounts.length) {
    return usedIndexes.size === items.length ? [] : null;
  }

  const subsetMatches = findSubsetsForAmount(items, chargeAmounts[chargeIndex], usedIndexes);
  for (const subsetIndexes of subsetMatches) {
    const nextUsedIndexes = new Set([...usedIndexes, ...subsetIndexes]);
    const remainingAllocation = assignItemsToCharges(items, chargeAmounts, chargeIndex + 1, nextUsedIndexes);
    if (remainingAllocation) {
      return [subsetIndexes.map((index) => items[index]), ...remainingAllocation];
    }
  }

  return null;
}

function findSubsetsForAmount(items, targetAmount, usedIndexes) {
  const availableIndexes = items
    .map((_, index) => index)
    .filter((index) => !usedIndexes.has(index));
  const matches = [];
  const combinationCount = 2 ** availableIndexes.length;

  for (let mask = 1; mask < combinationCount; mask += 1) {
    const subsetIndexes = availableIndexes.filter((_, offset) => (mask & (1 << offset)) !== 0);
    const subsetTotal = sumNumbers(subsetIndexes.map((index) => items[index].amount));
    const gap = Math.abs(subsetTotal - targetAmount);
    if (gap <= getFuzzyMatchToleranceCents()) {
      matches.push({ subsetIndexes, gap });
    }
  }

  return matches
    .sort((left, right) => left.gap - right.gap || left.subsetIndexes.length - right.subsetIndexes.length)
    .map((match) => match.subsetIndexes);
}

function describeActualTransaction(transaction) {
  return {
    id: transaction.id,
    date: transaction.date,
    amount: transaction.amount,
    accountId: transaction.actualAccountId,
    accountName: transaction.actualAccountName,
    importedPayee: transaction.imported_payee,
    notes: transaction.notes,
  };
}

function buildSubtransactions(items, transaction) {
  const groupedItems = combineAllocatedItems(items);
  const allocatedAmounts = allocateItemAmountsToTransactionTotal(groupedItems, Math.abs(transaction.amount));

  return groupedItems.map((item, index) => ({
    amount: transaction.amount < 0 ? -allocatedAmounts[index] : allocatedAmounts[index],
    account: transaction.account,
    date: transaction.date,
    parent_id: transaction.id,
    is_child: true,
    is_parent: false,
    payee: transaction.payee,
    notes: item.title,
  }));
}

function calculateLineItemPrice(item) {
  const price = parseCurrencyAmount(item.price);
  const quantity = parseQuantity(item.quantity);
  return price === null ? null : price * quantity;
}

function parseQuantity(quantity) {
  const parsedQuantity = Number(quantity ?? 1);
  return Number.isInteger(parsedQuantity) && parsedQuantity > 0 ? parsedQuantity : 1;
}

function allocateAmountAcrossQuantity(totalAmount, quantity) {
  const baseAmount = Math.floor(totalAmount / quantity);
  const extraCentCount = totalAmount - baseAmount * quantity;

  return Array.from({ length: quantity }, (_, index) => (
    index < extraCentCount ? baseAmount + 1 : baseAmount
  ));
}

function combineAllocatedItems(items) {
  const groupedItems = [...groupBy(items, (item) => item.sourceLineId).values()];
  return groupedItems.map((group) => {
    const firstItem = group[0];
    return {
      amount: sumItemAmounts(group),
      title: formatGroupedItemTitle(firstItem.title, group.length, firstItem.sourceQuantity),
    };
  });
}

function formatGroupedItemTitle(title, allocatedQuantity, sourceQuantity) {
  if (sourceQuantity <= 1) {
    return title;
  }

  return `${allocatedQuantity}× ${title}`;
}

function groupBy(values, getKey) {
  const groups = new Map();
  for (const value of values) {
    const key = getKey(value);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  return groups;
}

function sumItemAmounts(items) {
  return sumNumbers(items.map((item) => item.amount ?? 0));
}

function sumNumbers(numbers) {
  return numbers.reduce((total, number) => total + number, 0);
}

function getFuzzyMatchToleranceCents() {
  return Number(process.env.FUZZY_MATCH_TOLERANCE_CENTS ?? DEFAULT_FUZZY_MATCH_TOLERANCE_CENTS);
}

function allocateItemAmountsToTransactionTotal(items, transactionTotal) {
  const itemTotal = sumItemAmounts(items);
  const rawAllocations = items.map((item) => (item.amount / itemTotal) * transactionTotal);
  const roundedAllocations = rawAllocations.map(Math.floor);
  let remainingCents = transactionTotal - roundedAllocations.reduce((total, amount) => total + amount, 0);

  const remainderOrder = rawAllocations
    .map((amount, index) => ({ index, remainder: amount - Math.floor(amount) }))
    .sort((left, right) => right.remainder - left.remainder);

  for (const { index } of remainderOrder) {
    if (remainingCents === 0) {
      break;
    }
    roundedAllocations[index] += 1;
    remainingCents -= 1;
  }

  return roundedAllocations;
}

function areDatesNear(leftDate, rightDate) {
  if (!leftDate || !rightDate) {
    return false;
  }

  const elapsedMilliseconds = Math.abs(new Date(leftDate).getTime() - new Date(rightDate).getTime());
  return elapsedMilliseconds <= MATCH_DATE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function isAmazonAccountTransaction(transaction) {
  const payeeNeedle = (process.env.AMAZON_PAYEE_MATCH ?? 'amazon').toLowerCase();
  return [transaction.payee_name, transaction.imported_payee, transaction.notes]
    .filter(Boolean)
    .some((value) => value.toLowerCase().includes(payeeNeedle));
}

function isUncategorizedTransaction(transaction) {
  return (
    !transaction.category &&
    !transaction.is_parent &&
    !transaction.is_child &&
    hasAmazonChargeDescriptor(transaction.notes)
  );
}

function hasAmazonChargeDescriptor(notes) {
  if (!notes) {
    return false;
  }

  return /^(AMAZON MKT|AMAZON\.COM|AMZN|Amazon\.com(?:\*|$))/i.test(notes);
}

function parseCurrencyAmount(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    return Math.round(Math.abs(value) * 100);
  }

  const normalizedValue = String(value).replace(/[^0-9.-]/g, '');
  if (!normalizedValue) {
    return null;
  }

  return Math.round(Math.abs(Number(normalizedValue)) * 100);
}

function normalizeServerUrl(serverUrl) {
  if (serverUrl.startsWith('http://') || serverUrl.startsWith('https://')) {
    return serverUrl;
  }

  return `https://${serverUrl}`;
}

function validateActualEnvironment() {
  for (const variableName of ['ACTUAL_SERVER_URL', 'ACTUAL_SERVER_PASSWORD', 'ACTUAL_BUDGET_SYNC_ID']) {
    getRequiredEnv(variableName);
  }
}

function getRequiredEnv(variableName) {
  const value = process.env[variableName];
  if (!value) {
    throw new Error(`Missing required environment variable: ${variableName}`);
  }
  return value;
}

function hasFlag(flagName) {
  return process.argv.includes(flagName);
}

function getOptionalArgument(argumentName) {
  const index = process.argv.indexOf(argumentName);
  if (index === -1) {
    return null;
  }

  return process.argv[index + 1] ?? null;
}

function getRequiredArgument(argumentName) {
  const value = getOptionalArgument(argumentName);
  if (!value) {
    throw new Error(`Missing required argument: ${argumentName}`);
  }
  return value;
}

function printUsage() {
  console.log(`Usage:
  node src/actual.js list
  node src/actual.js match --amazon-json ./data/amazon-history.json
  node src/actual.js run [--dry-run] [--amazon-json ./data/amazon-history.json] [--report ./output/match-proposals.json] [--safety-days 7]
`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
