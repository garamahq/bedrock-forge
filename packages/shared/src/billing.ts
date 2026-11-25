export interface BillingCurrencySettings {
  currency_code: string;
  currency_locale: string;
}

export const DEFAULT_BILLING_CURRENCY_SETTINGS: BillingCurrencySettings = {
  currency_code: "USD",
  currency_locale: "en-US",
};

/**
 * Create a currency formatter aligned with billing settings, falling back to
 * USD/en-US if stored values are incomplete or invalid.
 */
export function createMoneyFormatter(
  settings?: Partial<BillingCurrencySettings> | null,
): Intl.NumberFormat {
  const locale =
    settings?.currency_locale?.trim() ||
    DEFAULT_BILLING_CURRENCY_SETTINGS.currency_locale;
  const currency =
    settings?.currency_code?.trim().toUpperCase() ||
    DEFAULT_BILLING_CURRENCY_SETTINGS.currency_code;

  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    });
  } catch {
    return new Intl.NumberFormat(
      DEFAULT_BILLING_CURRENCY_SETTINGS.currency_locale,
      {
        style: "currency",
        currency: DEFAULT_BILLING_CURRENCY_SETTINGS.currency_code,
      },
    );
  }
}

export function formatBillingMoney(
  amount: string | number | null | undefined,
  settings?: Partial<BillingCurrencySettings> | null,
): string {
  const numeric =
    typeof amount === "number" ? amount : Number.parseFloat(String(amount ?? 0));
  return createMoneyFormatter(settings).format(
    Number.isFinite(numeric) ? numeric : 0,
  );
}
