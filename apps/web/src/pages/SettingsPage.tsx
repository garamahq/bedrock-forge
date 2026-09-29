import { useState } from "react";
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
import { Label } from "@/components/ui/label";

export function SettingsPage() {
  const [activeTab, setActiveTab] = useState("account");
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

      <div className="max-w-sm space-y-1.5">
        <Label
          htmlFor="settings-area"
          className="text-xs font-medium text-muted-foreground"
        >
          Settings area
        </Label>
        <select
          id="settings-area"
          aria-label="Settings area"
          value={activeTab}
          onChange={(event) => setActiveTab(event.target.value)}
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <optgroup label="Account">
            <option value="account">Profile &amp; security</option>
            <option value="integrations">Integrations</option>
          </optgroup>
          <optgroup label="Operations">
            <option value="automation">Automation</option>
            <option value="system-backup">System backup</option>
            <option value="plugins">Custom plugins</option>
          </optgroup>
          <optgroup label="Business">
            <option value="billing">Billing</option>
          </optgroup>
          <optgroup label="System">
            <option value="advanced">Advanced</option>
          </optgroup>
        </select>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="hidden">
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
