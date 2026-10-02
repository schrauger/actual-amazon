import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CONFIG_PATH = 'actual-amazon.json';

export async function loadAmazonConfig() {
  const configPath = path.resolve(
    process.env.ACTUAL_AMAZON_CONFIG ?? DEFAULT_CONFIG_PATH,
  );

  let config;

  try {
    const raw = await fs.readFile(configPath, 'utf8');
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Unable to read Amazon configuration ${configPath}: ${error.message}`,
    );
  }

  validateAmazonConfig(config);

  return {
    ...config,
    configPath,
  };
}

export function getConfiguredActualAccountNames(config) {
  return [
    ...new Set(
      Object.values(config.amazonAccounts)
        .flatMap((profile) => Object.values(profile.paymentMethods)),
    ),
  ];
}

export function getMappedActualAccountName(
  config,
  amazonAccountName,
  paymentMethodLast4,
) {
  const profile = config.amazonAccounts[amazonAccountName];

  if (!profile || !paymentMethodLast4) {
    return null;
  }

  return profile.paymentMethods[paymentMethodLast4] ?? null;
}

function validateAmazonConfig(config) {
  if (
    !config ||
    typeof config.amazonAccounts !== 'object' ||
    Array.isArray(config.amazonAccounts)
  ) {
    throw new Error(
      'Amazon configuration must contain an "amazonAccounts" object.',
    );
  }

  const profiles = Object.entries(config.amazonAccounts);

  if (profiles.length === 0) {
    throw new Error('Amazon configuration contains no Amazon accounts.');
  }

  for (const [accountName, profile] of profiles) {
    if (!profile.username) {
      throw new Error(`Amazon account "${accountName}" is missing "username".`);
    }

    if (!profile.cookieJar) {
      throw new Error(`Amazon account "${accountName}" is missing "cookieJar".`);
    }

    if (
      !profile.paymentMethods ||
      typeof profile.paymentMethods !== 'object' ||
      Array.isArray(profile.paymentMethods)
    ) {
      throw new Error(
        `Amazon account "${accountName}" must have a "paymentMethods" object.`,
      );
    }

    for (const [last4, actualAccount] of Object.entries(
      profile.paymentMethods,
    )) {
      if (!/^\d{4}$/.test(last4)) {
        throw new Error(
          `Invalid payment-method key "${last4}" for Amazon account "${accountName}".`,
        );
      }

      if (!actualAccount) {
        throw new Error(
          `Payment method ${last4} for Amazon account "${accountName}" has no Actual account.`,
        );
      }
    }
  }
}
