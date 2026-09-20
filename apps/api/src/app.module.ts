import { Module } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR, APP_FILTER } from "@nestjs/core";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { BullModule } from "@nestjs/bullmq";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { ScheduleModule } from "@nestjs/schedule";
import { MiddlewareConsumer, NestModule, RequestMethod } from "@nestjs/common";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { UsersModule } from "./modules/users/users.module";
import { ClientsModule } from "./modules/clients/clients.module";
import { TagsModule } from "./modules/tags/tags.module";
import { PackagesModule } from "./modules/packages/packages.module";
import { ServersModule } from "./modules/servers/servers.module";
import { ProjectsModule } from "./modules/projects/projects.module";
import { EnvironmentsModule } from "./modules/environments/environments.module";
import { CyberpanelModule } from "./modules/cyberpanel/cyberpanel.module";
import { BackupsModule } from "./modules/backups/backups.module";
import { PluginScansModule } from "./modules/plugin-scans/plugin-scans.module";
import { SyncModule } from "./modules/sync/sync.module";
import { DomainsModule } from "./modules/domains/domains.module";
import { MonitorsModule } from "./modules/monitors/monitors.module";
import { SettingsModule } from "./modules/settings/settings.module";
import { JobExecutionsModule } from "./modules/job-executions/job-executions.module";
import { InvoicesModule } from "./modules/invoices/invoices.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { ReportsModule } from "./modules/reports/reports.module";
import { MaintenanceModule } from "./modules/maintenance/maintenance.module";
import { AuditLogsModule } from "./modules/audit-logs/audit-logs.module";
import { DashboardModule } from "./modules/dashboard/dashboard.module";
import { GatewaysModule } from "./gateways/gateways.module";
import { EncryptionModule } from "./common/encryption/encryption.module";
import { PluginUpdateSchedulesModule } from "./modules/plugin-update-schedules/plugin-update-schedules.module";
import { WpActionsModule } from "./modules/wp-actions/wp-actions.module";
import { ConfigDriftModule } from "./modules/config-drift/config-drift.module";
import { CleanupSchedulesModule } from "./modules/cleanup-schedules/cleanup-schedules.module";
import { CustomPluginsModule } from "./modules/custom-plugins/custom-plugins.module";
import { SystemBackupsModule } from "./modules/system-backups/system-backups.module";
import { ThemeScansModule } from "./modules/theme-scans/theme-scans.module";
import { SecurityModule } from "./modules/security/security.module";
import { LighthouseModule } from "./modules/lighthouse/lighthouse.module";
import { RemoteOpsModule } from "./modules/remote-ops/remote-ops.module";
import { MaintenanceWindowsModule } from "./modules/maintenance-windows/maintenance-windows.module";
import { SearchModule } from "./modules/search/search.module";
import { IpAllowlistMiddleware } from "./common/middleware/ip-allowlist.middleware";
import { CorrelationIdMiddleware } from "./common/middleware/correlation-id.middleware";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { SettingsRepository } from "./modules/settings/settings.repository";
import { AuditInterceptor } from "./common/interceptors/audit.interceptor";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { QUEUES } from "@bedrock-forge/shared";
import appConfig from "./config/app.config";

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
      envFilePath: [".env"],
    }),

    // Redis-backed rate limiting (counter state survives restarts / scales horizontally)
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [{ ttl: 60_000, limit: 100 }],
        storage: new ThrottlerStorageRedisService(
          config.get<string>("redis.url")!,
        ),
      }),
    }),

    // Nightly cleanup cron jobs
    ScheduleModule.forRoot(),

    // BullMQ queues
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get<string>("redis.url"),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: "exponential", delay: 1000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      }),
    }),

    // Register all queues
    BullModule.registerQueue(
      { name: QUEUES.BACKUPS },
      { name: QUEUES.PLUGIN_SCANS },
      { name: QUEUES.SYNC },
      { name: QUEUES.MONITORS },
      { name: QUEUES.DOMAINS },
      { name: QUEUES.PROJECTS },
      { name: QUEUES.NOTIFICATIONS },
      { name: QUEUES.REPORTS },
      { name: QUEUES.PLUGIN_UPDATES },
      { name: QUEUES.WP_ACTIONS },
      { name: QUEUES.CUSTOM_PLUGINS },
      { name: QUEUES.SYSTEM_BACKUPS },
      { name: QUEUES.THEME_SCANS },
      { name: QUEUES.SECURITY },
    ),

    // Infrastructure
    PrismaModule,
    EncryptionModule,

    // Feature modules
    AuthModule,
    HealthModule,
    UsersModule,
    ClientsModule,
    TagsModule,
    PackagesModule,
    ServersModule,
    ProjectsModule,
    EnvironmentsModule,
    CyberpanelModule,
    BackupsModule,
    PluginScansModule,
    SyncModule,
    DomainsModule,
    MonitorsModule,
    SettingsModule,
    JobExecutionsModule,
    InvoicesModule,
    NotificationsModule,
    ReportsModule,
    MaintenanceModule,
    AuditLogsModule,
    DashboardModule,
    GatewaysModule,
    PluginUpdateSchedulesModule,
    WpActionsModule,
    ConfigDriftModule,
    CleanupSchedulesModule,
    CustomPluginsModule,
    SystemBackupsModule,
    ThemeScansModule,
    SecurityModule,
    LighthouseModule,
    RemoteOpsModule,
    MaintenanceWindowsModule,
    SearchModule,
  ],
  providers: [
    // Global rate limiting — 100 req/min per IP (ThrottlerModule configured above)
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Global exception handler — normalises all errors to { statusCode, timestamp, path, message }
    { provide: APP_FILTER, useClass: HttpExceptionFilter },
    // Global request/response trace logger
    { provide: APP_INTERCEPTOR, useClass: LoggingInterceptor },
    // Global audit trail — logs all non-GET requests to audit_logs
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    IpAllowlistMiddleware,
    SettingsRepository,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    // Request Correlation ID Middleware runs first on all routes
    consumer
      .apply(CorrelationIdMiddleware)
      .forRoutes("*");

    // Health endpoint sits outside the /api prefix (excluded in main.ts via setGlobalPrefix).
    // Auth endpoints are always reachable regardless of IP allowlist so
    // operators can log in from any location. The allowlist only applies
    // to authenticated API routes after the user has a valid session.
    // We specify detailed RouteInfo configurations to ensure consistent matching
    // regardless of global prefix inclusion or leading slashes.
    consumer
      .apply(IpAllowlistMiddleware)
      .exclude(
        // Health check (unprefixed and prefixed)
        { path: "health", method: RequestMethod.GET },
        { path: "/health", method: RequestMethod.GET },
        { path: "api/health", method: RequestMethod.GET },
        { path: "/api/health", method: RequestMethod.GET },
        // Login
        { path: "auth/login", method: RequestMethod.POST },
        { path: "/auth/login", method: RequestMethod.POST },
        { path: "api/auth/login", method: RequestMethod.POST },
        { path: "/api/auth/login", method: RequestMethod.POST },
        // Refresh
        { path: "auth/refresh", method: RequestMethod.POST },
        { path: "/auth/refresh", method: RequestMethod.POST },
        { path: "api/auth/refresh", method: RequestMethod.POST },
        { path: "/api/auth/refresh", method: RequestMethod.POST },
        // Logout
        { path: "auth/logout", method: RequestMethod.POST },
        { path: "/auth/logout", method: RequestMethod.POST },
        { path: "api/auth/logout", method: RequestMethod.POST },
        { path: "/api/auth/logout", method: RequestMethod.POST },
        // Webhooks (deploy webhook token/HMAC authenticated, dynamic GitHub IPs)
        { path: "webhooks/deploy/:envId", method: RequestMethod.POST },
        { path: "/webhooks/deploy/:envId", method: RequestMethod.POST },
        { path: "api/webhooks/deploy/:envId", method: RequestMethod.POST },
        { path: "/api/webhooks/deploy/:envId", method: RequestMethod.POST },
      )
      .forRoutes("*");
  }
}
