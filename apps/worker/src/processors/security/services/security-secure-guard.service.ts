import { Injectable, Logger } from "@nestjs/common";
import { Job } from "bullmq";
import { PrismaService } from "../../../prisma/prisma.service";
import { SshKeyService } from "../../../services/ssh-key.service";
import { StepTracker } from "../../../services/step-tracker";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  SecureGuardInstallPayloadSchema,
  SecureGuardWatchdogPayloadSchema,
} from "@bedrock-forge/shared";
import {
  shellQuote,
  WpCliBuilder,
  detectSiteOwnerAndGroup,
} from "../../../utils/processor-utils";

const WATCHDOG_PHP_CONTENT = `<?php
/**
 * Plugin Name: Secure Guard Watchdog
 * Description: Runtime early-execution watchdog and tamper detection for Secure Guard.
 * Author: Garama
 * Version: 1.0.0
 */

if (!defined('ABSPATH')) {
    exit;
}

add_action('muplugins_loaded', function() {
    // Watchdog heartbeat and emergency lockdown check
    $lock_state = get_option('secure_guard_lock_state', []);
    if (is_array($lock_state) && !empty($lock_state['emergency_lockdown'])) {
        if (!defined('SECURE_GUARD_EMERGENCY_LOCKDOWN')) {
            define('SECURE_GUARD_EMERGENCY_LOCKDOWN', true);
        }
    }
}, 1);
`;

@Injectable()
export class SecuritySecureGuardService {
  private readonly logger = new Logger(SecuritySecureGuardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
  ) {}

  async installSecureGuard(job: Job) {
    const payload = SecureGuardInstallPayloadSchema.parse(job.data);
    const { environmentId, jobExecutionId, preset, deployWatchdog } = payload;

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      await tracker.track({
        step: "Resolving environment",
        level: "info",
        detail: `Environment #${environmentId}`,
      });

      const env = await this.prisma.environment.findUnique({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });
      if (!env) throw new Error(`Environment ${environmentId} not found`);
      if (!env.root_path) throw new Error(`Environment root_path is missing`);

      const rootPath = env.root_path.replace(/\/+$/, "");
      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(env.server),
      );

      // 1. Detect Bedrock vs standard WordPress paths
      const isBedrockCheck = await executor.execute(
        `test -d ${shellQuote(rootPath + "/web/app/plugins")} && echo "bedrock" || echo "standard"`,
      );
      const isBedrock = isBedrockCheck.stdout.trim() === "bedrock";

      const pluginsDir = isBedrock
        ? `${rootPath}/web/app/plugins`
        : `${rootPath}/wp-content/plugins`;
      const muPluginsDir = isBedrock
        ? `${rootPath}/web/app/mu-plugins`
        : `${rootPath}/wp-content/mu-plugins`;
      const targetPluginDir = `${pluginsDir}/wp-secure-guard`;

      await tracker.track({
        step: "Detected WordPress layout",
        level: "info",
        detail: `Layout: ${isBedrock ? "Bedrock" : "Standard WP"} | Plugins dir: ${pluginsDir}`,
      });

      // 2. Ensure plugins directory exists
      await executor.execute(`mkdir -p ${shellQuote(pluginsDir)}`);

      // 3. Clone or pull garamahq/wp-secure-guard
      await tracker.track({
        step: "Downloading Secure Guard plugin from GitHub",
        level: "info",
        detail: "Source: https://github.com/garamahq/wp-secure-guard",
      });

      const gitCheck = await executor.execute(
        `test -d ${shellQuote(targetPluginDir + "/.git")} && echo "git" || (test -d ${shellQuote(targetPluginDir)} && echo "dir" || echo "none")`,
      );
      const gitState = gitCheck.stdout.trim();

      if (gitState === "git") {
        await tracker.trackCommand(
          "Updating existing Git repository",
          `git -C ${targetPluginDir} fetch origin && git -C ${targetPluginDir} reset --hard origin/main`,
          await executor.execute(
            `git -C ${shellQuote(targetPluginDir)} fetch origin && git -C ${shellQuote(targetPluginDir)} reset --hard origin/main`,
          ),
        );
      } else {
        if (gitState === "dir") {
          await executor.execute(`rm -rf ${shellQuote(targetPluginDir)}`);
        }
        // Attempt git clone, fallback to tarball download
        const cloneRes = await executor.execute(
          `git clone --depth 1 https://github.com/garamahq/wp-secure-guard.git ${shellQuote(targetPluginDir)}`,
        );
        if (cloneRes.code !== 0) {
          await tracker.track({
            step: "Git clone failed, downloading tarball archive fallback",
            level: "warn",
            detail: cloneRes.stderr,
          });
          const archiveCmd = `curl -sL https://github.com/garamahq/wp-secure-guard/archive/refs/heads/main.tar.gz | tar -xz -C ${shellQuote(pluginsDir)} && rm -rf ${shellQuote(targetPluginDir)} && mv ${shellQuote(pluginsDir + "/wp-secure-guard-main")} ${shellQuote(targetPluginDir)}`;
          await tracker.trackCommand(
            "Extracted Secure Guard archive",
            archiveCmd,
            await executor.execute(archiveCmd),
          );
        } else {
          await tracker.trackCommand(
            "Cloned repository successfully",
            `git clone https://github.com/garamahq/wp-secure-guard.git`,
            cloneRes,
          );
        }
      }

      // 4. Deploy Watchdog MU-plugin if requested
      if (deployWatchdog !== false) {
        await tracker.track({
          step: "Deploying Watchdog MU-plugin",
          level: "info",
          detail: `Destination: ${muPluginsDir}/secure-guard-watchdog.php`,
        });

        await executor.execute(`mkdir -p ${shellQuote(muPluginsDir)}`);

        // Check if repo has watchdog file
        const repoWatchdogCheck = await executor.execute(
          `test -f ${shellQuote(targetPluginDir + "/secure-guard-watchdog.php")} && echo "root" || (test -f ${shellQuote(targetPluginDir + "/mu-plugins/secure-guard-watchdog.php")} && echo "mu" || echo "none")`,
        );
        const wdSource = repoWatchdogCheck.stdout.trim();

        if (wdSource === "root") {
          await executor.execute(
            `cp ${shellQuote(targetPluginDir + "/secure-guard-watchdog.php")} ${shellQuote(muPluginsDir + "/secure-guard-watchdog.php")}`,
          );
        } else if (wdSource === "mu") {
          await executor.execute(
            `cp ${shellQuote(targetPluginDir + "/mu-plugins/secure-guard-watchdog.php")} ${shellQuote(muPluginsDir + "/secure-guard-watchdog.php")}`,
          );
        } else {
          // Push fallback authoritative watchdog
          await executor.pushFile({
            remotePath: `${muPluginsDir}/secure-guard-watchdog.php`,
            content: Buffer.from(WATCHDOG_PHP_CONTENT, "utf-8"),
          });
        }
      }

      // 5. Activate plugin via WP-CLI
      const wpCli = await WpCliBuilder.create(executor, rootPath);
      let activateRes = await executor.execute(
        wpCli.buildCommand("plugin activate wp-secure-guard"),
      );
      if (activateRes.code !== 0) {
        // Fallback slug check
        activateRes = await executor.execute(
          wpCli.buildCommand("plugin activate secure-guard"),
        );
      }
      await tracker.trackCommand(
        "Activated Secure Guard plugin",
        "wp plugin activate wp-secure-guard",
        activateRes,
      );

      // 6. Apply Preset if specified
      if (preset) {
        await tracker.track({
          step: "Applying Secure Guard preset",
          level: "info",
          detail: `Preset: ${preset}`,
        });
        const presetRes = await executor.execute(
          wpCli.buildCommand(
            `option update secure_guard_preset ${shellQuote(preset)}`,
          ),
        );
        await tracker.trackCommand(
          "Preset updated",
          `wp option update secure_guard_preset ${preset}`,
          presetRes,
        );
      }

      // 7. Fix file permissions & ownership
      const { owner, webGroup } = await detectSiteOwnerAndGroup(
        executor,
        rootPath,
      );
      if (owner) {
        await executor.execute(
          `chown -R ${owner}:${webGroup} ${shellQuote(targetPluginDir)} ${shellQuote(muPluginsDir)} 2>/dev/null || true`,
        );
        await executor.execute(
          `chmod -R 755 ${shellQuote(targetPluginDir)} 2>/dev/null || true`,
        );
      }

      await tracker.complete({
        progress: 100,
      });

      this.logger.log(
        `Secure Guard successfully installed on environment #${environmentId}`,
      );
      return { success: true, environmentId };
    } catch (err: unknown) {
      await tracker.fail(err, "Secure Guard installation");
      throw err;
    }
  }

  async deployWatchdog(job: Job) {
    const payload = SecureGuardWatchdogPayloadSchema.parse(job.data);
    const { environmentId, jobExecutionId } = payload;

    const tracker = await StepTracker.start(
      this.prisma,
      jobExecutionId,
      this.logger,
      job,
    );

    try {
      const env = await this.prisma.environment.findUnique({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });
      if (!env) throw new Error(`Environment ${environmentId} not found`);
      if (!env.root_path) throw new Error(`Environment root_path is missing`);

      const rootPath = env.root_path.replace(/\/+$/, "");
      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(env.server),
      );

      const isBedrockCheck = await executor.execute(
        `test -d ${shellQuote(rootPath + "/web/app/plugins")} && echo "bedrock" || echo "standard"`,
      );
      const isBedrock = isBedrockCheck.stdout.trim() === "bedrock";

      const muPluginsDir = isBedrock
        ? `${rootPath}/web/app/mu-plugins`
        : `${rootPath}/wp-content/mu-plugins`;
      const pluginsDir = isBedrock
        ? `${rootPath}/web/app/plugins`
        : `${rootPath}/wp-content/plugins`;
      const targetPluginDir = `${pluginsDir}/wp-secure-guard`;

      await executor.execute(`mkdir -p ${shellQuote(muPluginsDir)}`);

      // Try copying from plugin or push content
      const checkRes = await executor.execute(
        `test -f ${shellQuote(targetPluginDir + "/secure-guard-watchdog.php")} && echo "root" || (test -f ${shellQuote(targetPluginDir + "/mu-plugins/secure-guard-watchdog.php")} && echo "mu" || echo "none")`,
      );
      const wdSource = checkRes.stdout.trim();

      if (wdSource === "root") {
        await executor.execute(
          `cp ${shellQuote(targetPluginDir + "/secure-guard-watchdog.php")} ${shellQuote(muPluginsDir + "/secure-guard-watchdog.php")}`,
        );
      } else if (wdSource === "mu") {
        await executor.execute(
          `cp ${shellQuote(targetPluginDir + "/mu-plugins/secure-guard-watchdog.php")} ${shellQuote(muPluginsDir + "/secure-guard-watchdog.php")}`,
        );
      } else {
        await executor.pushFile({
          remotePath: `${muPluginsDir}/secure-guard-watchdog.php`,
          content: Buffer.from(WATCHDOG_PHP_CONTENT, "utf-8"),
        });
      }

      const { owner, webGroup } = await detectSiteOwnerAndGroup(
        executor,
        rootPath,
      );
      if (owner) {
        await executor.execute(
          `chown -R ${owner}:${webGroup} ${shellQuote(muPluginsDir + "/secure-guard-watchdog.php")} 2>/dev/null || true`,
        );
      }

      await tracker.complete({ progress: 100 });
      return { success: true, environmentId };
    } catch (err: unknown) {
      await tracker.fail(err, "Watchdog deployment");
      throw err;
    }
  }
}
