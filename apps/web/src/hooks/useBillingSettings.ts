import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  type BillingCurrencySettings,
  createMoneyFormatter,
  DEFAULT_BILLING_CURRENCY_SETTINGS,
} from "@bedrock-forge/shared";
import { api } from "@/lib/api-client";

export type BillingSettings = BillingCurrencySettings;

export function useBillingSettings() {
  const query = useQuery<BillingSettings>({
    queryKey: ["settings", "billing"],
    queryFn: () => api.get("/settings/public/billing"),
    staleTime: 5 * 60_000,
  });

  const settings = query.data ?? DEFAULT_BILLING_CURRENCY_SETTINGS;
  const formatter = useMemo(
    () => createMoneyFormatter(settings),
    [settings.currency_code, settings.currency_locale],
  );

  return {
    ...query,
    settings,
    formatMoney: (amount: string | number) => {
      const value = Number.parseFloat(String(amount));
      return formatter.format(Number.isFinite(value) ? value : 0);
    },
  };
}
