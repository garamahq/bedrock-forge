import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NotificationsPage } from "@/pages/NotificationsPage";
import { GdriveStorage } from "./components/GdriveStorage";
import { CloudflareDns } from "./components/CloudflareDns";
import { PageSpeedIntegration } from "./components/PageSpeedIntegration";

export function IntegrationsTab() {
  return (
    <div className="space-y-6 w-full">
      <Tabs defaultValue="messaging">
        <TabsList className="mb-4">
          <TabsTrigger value="messaging">Messaging</TabsTrigger>
          <TabsTrigger value="storage">Storage</TabsTrigger>
          <TabsTrigger value="cloudflare">Cloudflare</TabsTrigger>
          <TabsTrigger value="pagespeed">PageSpeed / Lighthouse</TabsTrigger>
        </TabsList>

        <TabsContent value="messaging">
          <NotificationsPage />
        </TabsContent>

        <TabsContent value="storage">
          <GdriveStorage />
        </TabsContent>

        <TabsContent value="cloudflare">
          <CloudflareDns />
        </TabsContent>

        <TabsContent value="pagespeed">
          <PageSpeedIntegration />
        </TabsContent>
      </Tabs>
    </div>
  );
}
