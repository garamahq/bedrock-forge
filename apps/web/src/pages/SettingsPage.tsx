import { useAuthStore } from "@/store/auth.store";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Key,
  Cloud,
  RefreshCw,
  Puzzle,
  Database,
  CircleDollarSign,
  Settings as SettingsIcon,
} from "lucide-react";

import { AccountTab } from "./settings/AccountTab";
import { IntegrationsTab } from "./settings/IntegrationsTab";
import { AutomationTab } from "./settings/AutomationTab";
import { PluginsTab } from "./settings/PluginsTab";
import { BackupTab } from "./settings/BackupTab";
import { AdvancedTab } from "./settings/AdvancedTab";
import { BillingTab } from "./settings/BillingTab";

export function SettingsPage() {
  const isAdmin = useAuthStore(
    (s) => s.user?.roles?.includes("admin") ?? false,
  );

  if (!isAdmin) {
    return (
      <div className="space-y-6 w-full">
        <h1 className="text-2xl font-bold">Settings</h1>
        <AccountTab />
      </div>
    );
  }

  return (
    <div className="space-y-6 w-full">
      <h1 className="text-2xl font-bold">Settings</h1>

      <Tabs defaultValue="account">
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="account" className="flex items-center gap-1.5">
            <Key className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Account</span>
          </TabsTrigger>
          <TabsTrigger
            value="integrations"
            className="flex items-center gap-1.5"
          >
            <Cloud className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Integrations</span>
          </TabsTrigger>
          <TabsTrigger value="automation" className="flex items-center gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Automation</span>
          </TabsTrigger>
          <TabsTrigger value="plugins" className="flex items-center gap-1.5">
            <Puzzle className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Plugins</span>
          </TabsTrigger>
          <TabsTrigger value="billing" className="flex items-center gap-1.5">
            <CircleDollarSign className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Billing</span>
          </TabsTrigger>
          <TabsTrigger
            value="system-backup"
            className="flex items-center gap-1.5"
          >
            <Database className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Backup</span>
          </TabsTrigger>
          <TabsTrigger value="advanced" className="flex items-center gap-1.5">
            <SettingsIcon className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Advanced</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="account" className="mt-4">
          <AccountTab />
        </TabsContent>

        <TabsContent value="integrations" className="mt-4">
          <IntegrationsTab />
        </TabsContent>

        <TabsContent value="automation" className="mt-4">
          <AutomationTab />
        </TabsContent>

        <TabsContent value="plugins" className="mt-4">
          <PluginsTab />
        </TabsContent>

        <TabsContent value="billing" className="mt-4">
          <BillingTab />
        </TabsContent>

        <TabsContent value="system-backup" className="mt-4">
          <BackupTab />
        </TabsContent>

        <TabsContent value="advanced" className="mt-4">
          <AdvancedTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
