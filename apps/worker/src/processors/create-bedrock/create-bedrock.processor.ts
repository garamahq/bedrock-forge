import { Processor, WorkerHost, InjectQueue } from "@nestjs/bullmq";
import { Logger } from "@nestjs/common";
import { Job, Queue } from "bullmq";
import { randomBytes, randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { SshKeyService } from "../../services/ssh-key.service";
import { EncryptionService } from "../../encryption/encryption.service";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import {
  QUEUES,
  JOB_TYPES,
  CreateBedrockPayloadSchema,
  ProjectArchivePayloadSchema,
  ProjectRestorePayloadSchema,
  EnvironmentDecommissionPayloadSchema,
  BACKUP_JOB_OPTIONS,
} from "@bedrock-forge/shared";
import { callCpApi, CpCreds, escapeMysql } from "../../utils/cyberpanel-http";
import {
  shellQuote,
  flipProtocol,
  fixCyberPanelOwnership,
  createRemoteMyCnf,
  cleanupRemoteMyCnf,
  WpCliBuilder,
} from "../../utils/processor-utils";

// concurrency=1: Bedrock provisioning runs composer, git clone, SSH commands.
@Processor(QUEUES.PROJECTS, { concurrency: 1 })
export class CreateBedrockProcessor extends WorkerHost {
  private readonly logger = new Logger(CreateBedrockProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sshKey: SshKeyService,
    private readonly encryption: EncryptionService,
    @InjectQueue(QUEUES.BACKUPS) private readonly backupsQueue: Queue,
  ) {
    super();
  }

  async process(job: Job) {
    if (job.name === JOB_TYPES.PROJECT_CREATE_BEDROCK) {
      return this.handleCreateBedrock(job);
    }
    if (job.name === JOB_TYPES.PROJECT_ARCHIVE) {
      return this.handleProjectArchive(job);
    }
    if (job.name === JOB_TYPES.PROJECT_RESTORE) {
      return this.handleProjectRestore(job);
    }
    if (job.name === JOB_TYPES.ENVIRONMENT_DECOMMISSION) {
      return this.handleEnvironmentDecommission(job);
    }
  }

  private async handleCreateBedrock(job: Job) {
    const data = CreateBedrockPayloadSchema.parse(job.data);
    const { environmentId, jobExecutionId, cyberpanel, sourceEnvironmentId } =
      data;

    await this.prisma.jobExecution.update({
      where: { id: BigInt(jobExecutionId) },
      data: { status: "active", started_at: new Date() },
    });

    let websiteCreated = false;
    let cpCreds: CpCreds | null = null;
    let domain: string | null = null;

    try {
      const env = await this.prisma.environment.findUniqueOrThrow({
        where: { id: BigInt(environmentId) },
        include: { server: true },
      });
      const server = env.server;

      const executor = createRemoteExecutor(
        await this.sshKey.getSshConfig(server),
      );
      await job.updateProgress({ value: 5, step: "Connected to server" });

      // ── 1. CyberPanel provisioning ───────────────────────────────────

      if (cyberpanel) {
        domain = cyberpanel.domain;

        if (server.cyberpanel_login) {
          const raw = this.encryption.decrypt(
            server.cyberpanel_login as string,
          );
          cpCreds = JSON.parse(raw) as CpCreds;
        } else {
          throw new Error("Server has no CyberPanel credentials configured");
        }

        this.logger.log(`Creating CyberPanel website for ${domain}`);

        // Verify CyberPanel API is accessible before starting
        try {
          await callCpApi(cpCreds, "/api/verifyLogin", {});
        } catch (verifyErr) {
          throw new Error(
            `CyberPanel API is not accessible: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}. ` +
              "Ensure API access is enabled in CyberPanel Admin → Security → API Access.",
          );
        }

        await callCpApi(cpCreds, "/api/createWebsite", {
          domainName: domain,
          phpSelection: cyberpanel.phpVersion ?? "8.3",
          email: cyberpanel.adminEmail ?? "admin@example.com",
          websiteOwner: cpCreds.username,
          package: "Default",
          websiteOwnerEmail: cyberpanel.adminEmail ?? "admin@example.com",
          ssl: 0,
          dkim: 0,
          openbasedir: 0,
        });
        websiteCreated = true;
        await job.updateProgress({
          value: 20,
          step: "CyberPanel website created",
        });

        this.logger.log(`Creating database: ${cyberpanel.dbName}`);
        try {
          await callCpApi(cpCreds, "/api/submitDBCreation", {
            databaseWebsite: domain,
            dbName: cyberpanel.dbName,
            dbUsername: cyberpanel.dbUser,
            dbPassword: cyberpanel.dbPassword,
          });
        } catch (dbApiErr) {
          this.logger.warn(
            `CyberPanel submitDBCreation failed (${dbApiErr instanceof Error ? dbApiErr.message : String(dbApiErr)}), falling back to MySQL CLI`,
          );

          // Validate identifiers before embedding in backtick-quoted SQL.
          // MySQL identifiers are restricted to alphanumeric, underscore, hyphen.
          // This prevents backtick injection: escapeMysql() does not escape backticks.
          const safeIdentifier = /^[a-zA-Z0-9_-]{1,64}$/;
          if (!safeIdentifier.test(cyberpanel.dbName)) {
            throw new Error(
              `Database name '${cyberpanel.dbName}' contains characters that are not safe for MySQL CLI. ` +
                `Allowed: letters, numbers, underscores, hyphens.`,
            );
          }
          if (!safeIdentifier.test(cyberpanel.dbUser)) {
            throw new Error(
              `Database user '${cyberpanel.dbUser}' contains characters that are not safe for MySQL CLI.`,
            );
          }

          const dbName = cyberpanel.dbName; // validated above — safe for backtick quoting
          const dbUser = cyberpanel.dbUser; // validated above
          const dbPassword = escapeMysql(cyberpanel.dbPassword);
          const sqlQuery = `CREATE DATABASE IF NOT EXISTS \`${dbName}\`; ` +
            `CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPassword}'; ` +
            `GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO '${dbUser}'@'localhost'; ` +
            `FLUSH PRIVILEGES;`;
          const mysqlResult = await executor.execute(
            `mysql -e ${shellQuote(sqlQuery)}`,
          );
          if (mysqlResult.code !== 0) {
            throw new Error(
              `Database creation failed via both CyberPanel API and MySQL CLI. ` +
                `API error: ${dbApiErr instanceof Error ? dbApiErr.message : String(dbApiErr)}. ` +
                `MySQL error: ${mysqlResult.stderr}`,
            );
          }
          this.logger.log(
            `Database ${cyberpanel.dbName} created via MySQL CLI`,
          );
        }
        await job.updateProgress({ value: 30, step: "Database created" });
      }

      // ── 2a. Clone mode ───────────────────────────────────────────────

      if (sourceEnvironmentId) {
        const srcEnv = await this.prisma.environment.findUniqueOrThrow({
          where: { id: BigInt(sourceEnvironmentId) },
          include: {
            server: true,
            wp_db_credentials: true,
          },
        });

        if (!srcEnv.wp_db_credentials) {
          throw new Error("Source environment has no DB credentials stored");
        }

        const sc = srcEnv.wp_db_credentials;
        const srcCreds = {
          dbName: this.encryption.decrypt(sc.db_name_encrypted),
          dbUser: this.encryption.decrypt(sc.db_user_encrypted),
          dbPassword: this.encryption.decrypt(sc.db_password_encrypted),
          dbHost: this.encryption.decrypt(sc.db_host_encrypted),
        };

        const srcExecutor = createRemoteExecutor(
          await this.sshKey.getSshConfig(srcEnv.server),
        );

        await job.updateProgress({
          value: 35,
          step: "Connected to source server",
        });

        // ── Dump source DB ──
        const dumpTmp = `/tmp/cb_clone_${job.id}.sql`;
        const srcMycnf = await createRemoteMyCnf(
          srcExecutor,
          srcCreds,
          job.id ?? "default",
          "cb_src",
        );
        try {
          const dumpResult = await srcExecutor.execute(
            `mysqldump --defaults-extra-file=${shellQuote(srcMycnf)} --single-transaction --quick ${shellQuote(srcCreds.dbName)} > ${shellQuote(dumpTmp)}`,
          );
          if (dumpResult.code !== 0) {
            throw new Error(
              `mysqldump failed (exit ${dumpResult.code}): ${dumpResult.stderr}`,
            );
          }
        } finally {
          await cleanupRemoteMyCnf(srcExecutor, srcMycnf);
        }
        await job.updateProgress({ value: 50, step: "Source database dumped" });

        // ── Transfer + import ──
        const dumpBuffer = await srcExecutor.pullFile(dumpTmp);
        await srcExecutor.execute(`rm -f ${shellQuote(dumpTmp)}`).catch(() => {});

        const dbName = cyberpanel?.dbName ?? srcCreds.dbName;
        const dbUser = cyberpanel?.dbUser ?? srcCreds.dbUser;
        const dbPassword = cyberpanel?.dbPassword ?? srcCreds.dbPassword;
        const dbHost = "localhost";

        const tgtMycnf = await createRemoteMyCnf(
          executor,
          { dbUser, dbPassword, dbHost },
          job.id ?? "default",
          "cb_tgt",
        );
        await executor.pushFile({ remotePath: dumpTmp, content: dumpBuffer });
        try {
          const importResult = await executor.execute(
            `mysql --defaults-extra-file=${shellQuote(tgtMycnf)} ${shellQuote(dbName)} < ${shellQuote(dumpTmp)}`,
          );
          if (importResult.code !== 0) {
            throw new Error(
              `mysql import failed (exit ${importResult.code}): ${importResult.stderr}`,
            );
          }
        } finally {
          await cleanupRemoteMyCnf(executor, tgtMycnf);
          await executor.execute(`rm -f ${shellQuote(dumpTmp)}`).catch(() => {});
        }
        await job.updateProgress({ value: 60, step: "Database imported" });

        // ── rsync files ──
        const srcPath = srcEnv.root_path?.replace(/\/+$/, "") ?? "";
        const tgtPath = env.root_path?.replace(/\/+$/, "") ?? "";

        if (srcPath && tgtPath && srcEnv.server.id === server.id) {
          // Same server — local rsync
          await executor.execute(
            `rsync -a --delete ${shellQuote(srcPath + "/")} ${shellQuote(tgtPath + "/")}`,
          );
        } else if (srcPath && tgtPath) {
          // Cross-server via tar pipe
          const srcKey = await this.sshKey.resolvePrivateKey(srcEnv.server);
          const keyTmp = `/tmp/cb_key_${job.id}`;
          await executor.pushFile({ remotePath: keyTmp, content: srcKey });
          await executor.execute(`chmod 600 ${shellQuote(keyTmp)}`);
          try {
            await executor.execute(
              `chattr -R -i -a ${shellQuote(tgtPath)} 2>/dev/null || true; chmod -R u+w ${shellQuote(tgtPath)} 2>/dev/null || true; mkdir -p ${shellQuote(tgtPath)}`,
            );
            const pullResult = await executor.execute(
              `ssh -o StrictHostKeyChecking=no -i ${shellQuote(keyTmp)} ${shellQuote(srcEnv.server.ssh_user)}@${shellQuote(srcEnv.server.ip_address)} "tar -cz -C ${shellQuote(srcPath)} ." | tar -xz -C ${shellQuote(tgtPath)} --no-same-owner --no-same-permissions --touch --unlink-first --warning=no-timestamp`,
            );
            if (pullResult.code !== 0) {
              throw new Error(`Failed to transfer files from source server: ${pullResult.stderr}`);
            }
          } finally {
            await executor.execute(`rm -f ${shellQuote(keyTmp)}`).catch(() => {});
          }
        }
        await job.updateProgress({ value: 70, step: "Files synced" });

        // ── URL search-replace (SQL — zero wp-cli per PROJECT.md) ─────────────
        const srcUrl = srcEnv.url ?? null;
        const tgtUrl = env.url ?? null;

        if (srcUrl && tgtUrl && srcUrl !== tgtUrl) {
          const srMycnf = await createRemoteMyCnf(
            executor,
            { dbUser, dbPassword, dbHost: "localhost" },
            job.id ?? "default",
            "cb_sr",
          );
          const srSqlFile = `/tmp/cb_sr_${job.id}.sql`;
          try {
            const pairs: Array<[string, string]> = [[srcUrl, tgtUrl]];
            const alt = flipProtocol(srcUrl);
            const altTgt = flipProtocol(tgtUrl);
            if (alt && altTgt && alt !== tgtUrl) pairs.push([alt, altTgt]);

            // Auto-detect WP table prefix; fallback 'wp_'
            const prefixRes = await executor.execute(
              `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(dbName)} -sN -e ${shellQuote(
                `SELECT REPLACE(table_name,'options','') FROM information_schema.tables WHERE table_schema='${escapeMysql(dbName)}' AND table_name LIKE '%options' LIMIT 1`,
              )}`,
            );
            const p =
              prefixRes.code === 0 && prefixRes.stdout.trim()
                ? prefixRes.stdout.trim()
                : "wp_";

            const statements: string[] = [];
            for (const [oldRaw, newRaw] of pairs) {
              const o = escapeMysql(oldRaw);
              const n = escapeMysql(newRaw);
              statements.push(
                `UPDATE \`${p}options\` SET option_value = REPLACE(option_value, '${o}', '${n}')`,
                `UPDATE \`${p}posts\` SET post_content = REPLACE(post_content, '${o}', '${n}')`,
                `UPDATE \`${p}posts\` SET post_excerpt = REPLACE(post_excerpt, '${o}', '${n}')`,
                `UPDATE \`${p}postmeta\` SET meta_value = REPLACE(CAST(meta_value AS CHAR), '${o}', '${n}')`,
                `UPDATE \`${p}usermeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                `UPDATE \`${p}comments\` SET comment_content = REPLACE(comment_content, '${o}', '${n}')`,
                `UPDATE \`${p}comments\` SET comment_author_url = REPLACE(comment_author_url, '${o}', '${n}')`,
                `UPDATE \`${p}commentmeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                `UPDATE \`${p}termmeta\` SET meta_value = REPLACE(meta_value, '${o}', '${n}')`,
                `UPDATE \`${p}links\` SET link_url = REPLACE(link_url, '${o}', '${n}')`,
                `UPDATE \`${p}links\` SET link_image = REPLACE(link_image, '${o}', '${n}')`,
                `UPDATE \`${p}links\` SET link_rss = REPLACE(link_rss, '${o}', '${n}')`,
              );
            }
            await executor.pushFile({
              remotePath: srSqlFile,
              content: Buffer.from(statements.join(";\n") + ";"),
            });
            const srResult = await executor.execute(
              `mysql --defaults-extra-file=${shellQuote(srMycnf)} ${shellQuote(dbName)} < ${shellQuote(srSqlFile)}`,
            );
            if (srResult.code !== 0) {
              this.logger.warn(
                `URL search-replace SQL failed: ${srResult.stderr}`,
              );
            }
          } finally {
            await cleanupRemoteMyCnf(executor, srMycnf);
            await executor.execute(`rm -f ${shellQuote(srSqlFile)}`).catch(() => {});
          }
        }
        await job.updateProgress({
          value: 80,
          step: "URL search-replace done",
        });

        // Replace hardcoded URLs in wp-content files (CSS, JS, PHP, etc.)
        if (srcUrl && tgtUrl && srcUrl !== tgtUrl) {
          const sedEscape = (s: string) =>
            s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
          const wpContent = `${tgtPath}/wp-content`;
          const filePairs: Array<[string, string]> = [[srcUrl, tgtUrl]];
          const altSrc = flipProtocol(srcUrl);
          const altTgt = flipProtocol(tgtUrl);
          if (altSrc && altTgt && altSrc !== tgtUrl)
            filePairs.push([altSrc, altTgt]);
          for (const [oldUrl, newUrl] of filePairs) {
            await executor
              .execute(
                [
                  `find ${shellQuote(wpContent)} -type f`,
                  `\\( -name '*.css' -o -name '*.js' -o -name '*.json' -o -name '*.html'`,
                  `-o -name '*.htm' -o -name '*.svg' -o -name '*.xml' -o -name '*.txt'`,
                  `-o -name '*.php' \\)`,
                  `-exec sed -i 's|${sedEscape(oldUrl)}|${sedEscape(newUrl)}|g' {} +`,
                ].join(" "),
              )
              .catch(() => {});
          }
        }

        // Flush WordPress caches (WP-CLI preferred; disk cache fallback)
        // Run as the site owner so their PHP-FPM environment (with mysqli) is used.
        {
          const wpCli = await WpCliBuilder.create(executor, tgtPath);
          await executor
            .execute(wpCli.buildCommand("cache flush"))
            .catch(() => {});
          await executor
            .execute(wpCli.buildCommand("rewrite flush"))
            .catch(() => {});
        }
        await executor
          .execute(
            `rm -rf ${shellQuote(tgtPath)}/wp-content/cache ${shellQuote(tgtPath)}/wp-content/et-cache 2>/dev/null; true`,
          )
          .catch(() => {});

        // Write .env with new DB + URL
        const dbName2 = cyberpanel?.dbName ?? srcCreds.dbName;
        const dbUser2 = cyberpanel?.dbUser ?? srcCreds.dbUser;
        const dbPassword2 = cyberpanel?.dbPassword ?? srcCreds.dbPassword;
        await this.writeEnvFile(
          executor,
          env.root_path ?? "",
          dbName2,
          dbUser2,
          dbPassword2,
          "localhost",
          env.type ?? "production",
          env.url ?? "",
        );

        // Store WpDbCredentials in Prisma
        await this.storeDbCredentials(
          environmentId,
          dbName2,
          dbUser2,
          dbPassword2,
          "localhost",
        );
      } else {
        // ── 2b. Fresh Bedrock install ────────────────────────────────

        const dbName = cyberpanel?.dbName ?? "wordpress";
        const dbUser = cyberpanel?.dbUser ?? "wordpress";
        const dbPassword = cyberpanel?.dbPassword ?? "";
        const dbHost = cyberpanel?.dbHost ?? "localhost";

        // Install Composer if missing
        const composerCheck = await executor.execute(
          "command -v composer && echo ok || echo missing",
        );
        if (composerCheck.stdout.trim().includes("missing")) {
          await executor.execute(
            "php -r \"copy('https://getcomposer.org/installer', '/tmp/composer-setup.php');\" && php /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer && rm /tmp/composer-setup.php",
          );
        }
        await job.updateProgress({ value: 40, step: "Composer ready" });

        // Create Bedrock project
        const rootPath =
          env.root_path ?? `/home/${domain ?? "site"}/public_html`;
        await executor.execute(
          `chattr -R -i -a ${shellQuote(rootPath)} 2>/dev/null || true; chmod -R u+w ${shellQuote(rootPath)} 2>/dev/null || true; rm -rf ${shellQuote(rootPath)} && composer create-project roots/bedrock ${shellQuote(rootPath)} --no-interaction`,
        );
        await job.updateProgress({ value: 70, step: "Bedrock installed" });

        await this.writeEnvFile(
          executor,
          rootPath,
          dbName,
          dbUser,
          dbPassword,
          dbHost,
          env.type ?? "production",
          env.url ?? "",
        );
        await this.storeDbCredentials(
          environmentId,
          dbName,
          dbUser,
          dbPassword,
          dbHost,
        );
      }

      // Fix ownership: public_html itself → user:nogroup (750), contents → user:user
      await fixCyberPanelOwnership(executor, env.root_path);

      await job.updateProgress({ value: 95, step: "Finalizing" });

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: { status: "completed", completed_at: new Date() },
      });

      await job.updateProgress({ value: 100, step: "Done" });
      this.logger.log(
        `Bedrock setup complete for environment #${environmentId}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`CreateBedrock job failed: ${msg}`);

      // Rollback CyberPanel website if we created it
      if (websiteCreated && cpCreds && domain) {
        try {
          await callCpApi(cpCreds, "/api/deleteWebsite", {
            domainName: domain,
          });
          this.logger.warn(`Rolled back CyberPanel website: ${domain}`);
        } catch (rollbackErr) {
          this.logger.error(`CyberPanel rollback failed: ${rollbackErr}`);
        }
      }

      // Detach job execution from the environment before deleting it
      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "failed",
          last_error: msg,
          completed_at: new Date(),
          environment_id: null,
        },
      });

      // Clean up local DB records so orphaned projects don't linger
      try {
        const envRecord = await this.prisma.environment.findUnique({
          where: { id: BigInt(environmentId) },
          select: { project_id: true },
        });
        if (envRecord) {
          await this.prisma.environment.delete({
            where: { id: BigInt(environmentId) },
          });
          // Delete project only if it has no other environments
          const remaining = await this.prisma.environment.count({
            where: { project_id: envRecord.project_id },
          });
          if (remaining === 0) {
            await this.prisma.project.delete({
              where: { id: envRecord.project_id },
            });
          }
          this.logger.warn(
            `Cleaned up local records for failed environment #${environmentId}`,
          );
        }
      } catch (cleanupErr) {
        this.logger.error(`Local DB cleanup failed: ${cleanupErr}`);
      }

      throw err;
    }
  }

  private async writeEnvFile(
    executor: ReturnType<typeof createRemoteExecutor>,
    rootPath: string,
    dbName: string,
    dbUser: string,
    dbPassword: string,
    dbHost: string,
    wpEnv: string,
    wpHome: string,
  ) {
    // 64-character cryptographically secure random salt per WordPress specification
    const salt = () => randomBytes(48).toString("base64url").slice(0, 64);

    const escapeSingleQuote = (val: string) => val.replace(/'/g, "\\'");
    const envContent = [
      `DB_NAME='${escapeSingleQuote(dbName)}'`,
      `DB_USER='${escapeSingleQuote(dbUser)}'`,
      `DB_PASSWORD='${escapeSingleQuote(dbPassword)}'`,
      `DB_HOST='${escapeSingleQuote(dbHost)}'`,
      ``,
      `WP_ENV='${escapeSingleQuote(wpEnv)}'`,
      `WP_HOME='${escapeSingleQuote(wpHome)}'`,
      `WP_SITEURL=\${WP_HOME}/wp`,
      ``,
      `AUTH_KEY='${salt()}'`,
      `SECURE_AUTH_KEY='${salt()}'`,
      `LOGGED_IN_KEY='${salt()}'`,
      `NONCE_KEY='${salt()}'`,
      `AUTH_SALT='${salt()}'`,
      `SECURE_AUTH_SALT='${salt()}'`,
      `LOGGED_IN_SALT='${salt()}'`,
      `NONCE_SALT='${salt()}'`,
    ].join("\n");

    await executor.pushFile({
      remotePath: `${rootPath}/.env`,
      content: Buffer.from(envContent),
    });
  }

  private async storeDbCredentials(
    environmentId: number,
    dbName: string,
    dbUser: string,
    dbPassword: string,
    dbHost: string,
  ) {
    const data = {
      environment_id: BigInt(environmentId),
      db_name_encrypted: this.encryption.encrypt(dbName),
      db_user_encrypted: this.encryption.encrypt(dbUser),
      db_password_encrypted: this.encryption.encrypt(dbPassword),
      db_host_encrypted: this.encryption.encrypt(dbHost),
    };

    await this.prisma.wpDbCredentials.upsert({
      where: { environment_id: BigInt(environmentId) },
      create: data,
      update: {
        db_name_encrypted: data.db_name_encrypted,
        db_user_encrypted: data.db_user_encrypted,
        db_password_encrypted: data.db_password_encrypted,
        db_host_encrypted: data.db_host_encrypted,
      },
    });
  }

  private getDomainFromUrl(urlStr: string): string {
    try {
      const url = new URL(urlStr);
      return url.hostname;
    } catch {
      return urlStr
        .replace(/^https?:\/\//i, "")
        .replace(/:\d+/, "")
        .split("/")[0];
    }
  }

  private async handleProjectArchive(job: Job) {
    const data = ProjectArchivePayloadSchema.parse(job.data);
    const { projectId, jobExecutionId, createBackup, deleteFromCyberpanel, deleteProject } = data;

    await this.prisma.jobExecution.update({
      where: { id: BigInt(jobExecutionId) },
      data: { status: "active", started_at: new Date() },
    });

    try {
      const project = await this.prisma.project.findUniqueOrThrow({
        where: { id: BigInt(projectId) },
        include: {
          environments: {
            include: {
              server: true,
              wp_db_credentials: true,
            },
          },
        },
      });

      const envs = project.environments ?? [];
      const totalSteps = envs.length * ( (createBackup ? 1 : 0) + (deleteFromCyberpanel ? 1 : 0) );
      let currentStep = 0;

      for (const env of envs) {
        // Step 1: Create Backup
        if (createBackup) {
          await job.updateProgress({
            value: Math.round((currentStep / totalSteps) * 100),
            step: `Backing up environment: ${env.type}`,
          });

          if (!env.google_drive_folder_id) {
            throw new Error(`Environment ${env.id} (${env.type}) has no Google Drive folder ID configured`);
          }

          const bullJobId = randomUUID();
          const backupExec = await this.prisma.jobExecution.create({
            data: {
              queue_name: QUEUES.BACKUPS,
              job_type: JOB_TYPES.BACKUP_CREATE,
              bull_job_id: bullJobId,
              environment_id: env.id,
              status: "queued",
              payload: { environmentId: Number(env.id), type: "full" },
            },
          });

          const backup = await this.prisma.backup.create({
            data: {
              environment_id: env.id,
              type: "full",
              status: "pending",
            },
          });

          await this.backupsQueue.add(
            JOB_TYPES.BACKUP_CREATE,
            {
              environmentId: Number(env.id),
              type: "full",
              jobExecutionId: Number(backupExec.id),
              backupId: Number(backup.id),
            },
            { ...BACKUP_JOB_OPTIONS, jobId: bullJobId },
          );

          // Poll for backup completion
          let isDone = false;
          const startTime = Date.now();
          while (!isDone && (Date.now() - startTime < 15 * 60 * 1000)) {
            const exec = await this.prisma.jobExecution.findUnique({
              where: { id: backupExec.id },
            });
            if (!exec) throw new Error("Backup execution trace deleted");
            if (exec.status === "completed") {
              isDone = true;
            } else if (exec.status === "failed") {
              throw new Error(`Backup failed: ${exec.last_error}`);
            } else {
              await new Promise((resolve) => setTimeout(resolve, 5000));
            }
          }
          if (!isDone) {
            throw new Error(`Backup timed out after 15 minutes`);
          }

          currentStep++;
        }

        // Step 2: Delete from CyberPanel
        if (deleteFromCyberpanel) {
          await job.updateProgress({
            value: Math.round((currentStep / totalSteps) * 100),
            step: `Deleting website from CyberPanel: ${env.type}`,
          });

          const server = env.server;
          if (server.cyberpanel_login) {
            const raw = this.encryption.decrypt(server.cyberpanel_login as string);
            const cpCreds = JSON.parse(raw) as CpCreds;
            const domain = this.getDomainFromUrl(env.url);

            this.logger.log(`Deleting CyberPanel website ${domain} for env ${env.id}`);
            try {
              await callCpApi(cpCreds, "/api/deleteWebsite", {
                domainName: domain,
              });
            } catch (apiErr) {
              this.logger.error(`CyberPanel deleteWebsite API call failed for domain ${domain}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
            }
          } else {
            this.logger.warn(`Server ${server.id} has no CyberPanel credentials — website deletion skipped`);
          }

          // Clean up database & database user if credentials exist
          if (env.wp_db_credentials) {
            try {
              const dbName = this.encryption.decrypt(env.wp_db_credentials.db_name_encrypted);
              const dbUser = this.encryption.decrypt(env.wp_db_credentials.db_user_encrypted);

              const safeIdentifier = /^[a-zA-Z0-9_-]{1,64}$/;
              if (!safeIdentifier.test(dbName)) {
                throw new Error(`Database name '${dbName}' contains unsafe characters`);
              }
              if (!safeIdentifier.test(dbUser)) {
                throw new Error(`Database user '${dbUser}' contains unsafe characters`);
              }

              this.logger.log(`Dropping database ${dbName} and user ${dbUser} on server ${server.id}`);
              const sshConfig = await this.sshKey.getSshConfig(server);
              const executor = createRemoteExecutor(sshConfig);

              this.logger.log(`Attempting CyberPanel CLI database deletion for ${dbName}`);
              const cpCliResult = await executor.execute(`cyberpanel deleteDatabase --databaseName ${shellQuote(dbName)}`);
              if (cpCliResult.code === 0) {
                this.logger.log(`Successfully deleted database ${dbName} via CyberPanel CLI`);
              } else {
                this.logger.warn(`CyberPanel CLI database deletion failed (code ${cpCliResult.code}): ${cpCliResult.stderr || cpCliResult.stdout}. Falling back to manual MySQL cleanup.`);

                // 1. Drop the actual database
                await executor.execute(`mysql -e ${shellQuote(`DROP DATABASE IF EXISTS \`${dbName}\`;`)}`).catch((err) => {
                  this.logger.warn(`Failed to drop database \`${dbName}\`: ${err instanceof Error ? err.message : String(err)}`);
                });

                // 2. Drop the local MySQL user
                await executor.execute(`mysql -e ${shellQuote(`DROP USER IF EXISTS '${dbUser}'@'localhost';`)}`).catch((err) => {
                  this.logger.warn(`Failed to drop MySQL user '${dbUser}': ${err instanceof Error ? err.message : String(err)}`);
                });

                // 3. Delete metadata from CyberPanel's internal MySQL system database
                await executor.execute(`mysql -e ${shellQuote(`DELETE FROM cyberpanel.databases_databases WHERE dbname='${dbName}';`)}`).catch((err) => {
                  this.logger.warn(`Failed to delete record from cyberpanel.databases_databases for '${dbName}': ${err instanceof Error ? err.message : String(err)}`);
                });

                // 4. Flush privileges to ensure changes take effect
                await executor.execute(`mysql -e ${shellQuote("FLUSH PRIVILEGES;")}`).catch((err) => {
                  this.logger.warn(`Failed to flush MySQL privileges: ${err instanceof Error ? err.message : String(err)}`);
                });
              }

              this.logger.log(`Successfully completed cleanup for database ${dbName} and user ${dbUser} on server ${server.id}`);
            } catch (dbErr) {
              this.logger.error(`Database/user deletion failed for env ${env.id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
            }
          }

          currentStep++;
        }
      }

      await job.updateProgress({
        value: 100,
        step: "Archival completed successfully",
      });

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "completed",
          completed_at: new Date(),
          progress: 100,
        },
      });

      if (deleteProject) {
        this.logger.log(`ProjectArchive job: Purging project ${projectId} from DB`);
        await this.prisma.project.delete({
          where: { id: BigInt(projectId) },
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`ProjectArchive job failed: ${msg}`);

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "failed",
          last_error: msg,
          completed_at: new Date(),
        },
      });

      throw err;
    }
  }

  private async handleProjectRestore(job: Job) {
    const data = ProjectRestorePayloadSchema.parse(job.data);
    const { projectId, jobExecutionId, environmentBackups } = data;

    await this.prisma.jobExecution.update({
      where: { id: BigInt(jobExecutionId) },
      data: { status: "active", started_at: new Date() },
    });

    try {
      const project = await this.prisma.project.findUniqueOrThrow({
        where: { id: BigInt(projectId) },
        include: {
          environments: {
            include: {
              server: true,
              wp_db_credentials: true,
            },
          },
        },
      });

      const envs = project.environments ?? [];
      const totalSteps = envs.length * 3; // Recreate web, Recreate DB, Restore backup
      let currentStep = 0;

      for (const env of envs) {
        // Identify backup to restore
        let backupId = environmentBackups[String(env.id)];
        if (!backupId) {
          const latestBackup = await this.prisma.backup.findFirst({
            where: { environment_id: env.id, status: "completed" },
            orderBy: { created_at: "desc" },
          });
          if (!latestBackup) {
            throw new Error(`No completed backup found for environment ${env.id} (${env.type}) to restore`);
          }
          backupId = Number(latestBackup.id);
        }

        const server = env.server;
        const domain = this.getDomainFromUrl(env.url);

        // 1. Recreate website in CyberPanel
        await job.updateProgress({
          value: Math.round((currentStep / totalSteps) * 100),
          step: `Recreating CyberPanel website for environment: ${env.type}`,
        });

        if (server.cyberpanel_login) {
          const raw = this.encryption.decrypt(server.cyberpanel_login as string);
          const cpCreds = JSON.parse(raw) as CpCreds;

          await callCpApi(cpCreds, "/api/createWebsite", {
            domainName: domain,
            phpSelection: "8.3",
            email: "admin@example.com",
            websiteOwner: cpCreds.username,
            package: "Default",
            websiteOwnerEmail: "admin@example.com",
            ssl: 0,
            dkim: 0,
            openbasedir: 0,
          });

          currentStep++;

          // 2. Recreate Database in CyberPanel
          await job.updateProgress({
            value: Math.round((currentStep / totalSteps) * 100),
            step: `Recreating CyberPanel database for environment: ${env.type}`,
          });

          if (env.wp_db_credentials) {
            const dbName = this.encryption.decrypt(env.wp_db_credentials.db_name_encrypted);
            const dbUser = this.encryption.decrypt(env.wp_db_credentials.db_user_encrypted);
            const dbPassword = this.encryption.decrypt(env.wp_db_credentials.db_password_encrypted);

            await callCpApi(cpCreds, "/api/submitDBCreation", {
              databaseWebsite: domain,
              dbName,
              dbUsername: dbUser,
              dbPassword,
            });
          } else {
            this.logger.warn(`No database credentials configured for environment ${env.id} — database creation skipped`);
          }

          currentStep++;
        } else {
          this.logger.warn(`Server ${server.id} has no CyberPanel credentials — website/db creation skipped`);
          currentStep += 2;
        }

        // 3. Restore backup
        await job.updateProgress({
          value: Math.round((currentStep / totalSteps) * 100),
          step: `Restoring backup for environment: ${env.type}`,
        });

        const bullJobId = randomUUID();
        const restoreExec = await this.prisma.jobExecution.create({
          data: {
            queue_name: QUEUES.BACKUPS,
            job_type: JOB_TYPES.BACKUP_RESTORE,
            bull_job_id: bullJobId,
            environment_id: env.id,
            status: "queued",
            payload: { backupId, environmentId: Number(env.id) },
          },
        });

        await this.backupsQueue.add(
          JOB_TYPES.BACKUP_RESTORE,
          {
            backupId,
            environmentId: Number(env.id),
            jobExecutionId: Number(restoreExec.id),
          },
          { ...BACKUP_JOB_OPTIONS, jobId: bullJobId },
        );

        // Poll for restore completion
        let isDone = false;
        const startTime = Date.now();
        while (!isDone && (Date.now() - startTime < 15 * 60 * 1000)) {
          const exec = await this.prisma.jobExecution.findUnique({
            where: { id: restoreExec.id },
          });
          if (!exec) throw new Error("Restore execution trace deleted");
          if (exec.status === "completed") {
            isDone = true;
          } else if (exec.status === "failed") {
            throw new Error(`Backup restore failed: ${exec.last_error}`);
          } else {
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
        }
        if (!isDone) {
          throw new Error(`Backup restore timed out after 15 minutes`);
        }

        currentStep++;
      }

      await job.updateProgress({
        value: 100,
        step: "Restoration completed successfully",
      });

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "completed",
          completed_at: new Date(),
          progress: 100,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`ProjectRestore job failed: ${msg}`);

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "failed",
          last_error: msg,
          completed_at: new Date(),
        },
      });

      throw err;
    }
  }

  private async handleEnvironmentDecommission(job: Job) {
    const data = EnvironmentDecommissionPayloadSchema.parse(job.data);
    const { environmentId, jobExecutionId, deleteFromCyberpanel } = data;

    await this.prisma.jobExecution.update({
      where: { id: BigInt(jobExecutionId) },
      data: { status: "active", started_at: new Date() },
    });

    try {
      const env = await this.prisma.environment.findUnique({
        where: { id: BigInt(environmentId) },
        include: {
          server: true,
          wp_db_credentials: true,
        },
      });

      if (!env) {
        this.logger.warn(`Environment ${environmentId} already deleted or not found`);
      } else {
        if (deleteFromCyberpanel) {
          const server = env.server;
          const domain = this.getDomainFromUrl(env.url);

          // 1. Delete CyberPanel Website
          if (server.cyberpanel_login) {
            const raw = this.encryption.decrypt(server.cyberpanel_login as string);
            const cpCreds = JSON.parse(raw) as CpCreds;

            this.logger.log(`Deleting CyberPanel website ${domain} for env ${env.id}`);
            try {
              await callCpApi(cpCreds, "/api/deleteWebsite", {
                domainName: domain,
              });
            } catch (apiErr) {
              this.logger.error(`CyberPanel deleteWebsite API call failed for domain ${domain}: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
            }
          } else {
            this.logger.warn(`Server ${server.id} has no CyberPanel credentials — website deletion skipped`);
          }

          // 2. Drop database & database user
          if (env.wp_db_credentials) {
            try {
              const dbName = this.encryption.decrypt(env.wp_db_credentials.db_name_encrypted);
              const dbUser = this.encryption.decrypt(env.wp_db_credentials.db_user_encrypted);

              const safeIdentifier = /^[a-zA-Z0-9_-]{1,64}$/;
              if (!safeIdentifier.test(dbName)) {
                throw new Error(`Database name '${dbName}' contains unsafe characters`);
              }
              if (!safeIdentifier.test(dbUser)) {
                throw new Error(`Database user '${dbUser}' contains unsafe characters`);
              }

              this.logger.log(`Dropping database ${dbName} and user ${dbUser} on server ${server.id}`);
              const sshConfig = await this.sshKey.getSshConfig(server);
              const executor = createRemoteExecutor(sshConfig);

              this.logger.log(`Attempting CyberPanel CLI database deletion for ${dbName}`);
              const cpCliResult = await executor.execute(`cyberpanel deleteDatabase --databaseName ${shellQuote(dbName)}`);
              if (cpCliResult.code === 0) {
                this.logger.log(`Successfully deleted database ${dbName} via CyberPanel CLI`);
              } else {
                this.logger.warn(`CyberPanel CLI database deletion failed (code ${cpCliResult.code}): ${cpCliResult.stderr || cpCliResult.stdout}. Falling back to manual MySQL cleanup.`);

                // 1. Drop the actual database
                await executor.execute(`mysql -e ${shellQuote(`DROP DATABASE IF EXISTS \`${dbName}\`;`)}`).catch((err) => {
                  this.logger.warn(`Failed to drop database \`${dbName}\`: ${err instanceof Error ? err.message : String(err)}`);
                });

                // 2. Drop the local MySQL user
                await executor.execute(`mysql -e ${shellQuote(`DROP USER IF EXISTS '${dbUser}'@'localhost';`)}`).catch((err) => {
                  this.logger.warn(`Failed to drop MySQL user '${dbUser}': ${err instanceof Error ? err.message : String(err)}`);
                });

                // 3. Delete metadata from CyberPanel's internal MySQL system database
                await executor.execute(`mysql -e ${shellQuote(`DELETE FROM cyberpanel.databases_databases WHERE dbname='${dbName}';`)}`).catch((err) => {
                  this.logger.warn(`Failed to delete record from cyberpanel.databases_databases for '${dbName}': ${err instanceof Error ? err.message : String(err)}`);
                });

                // 4. Flush privileges to ensure changes take effect
                await executor.execute(`mysql -e ${shellQuote("FLUSH PRIVILEGES;")}`).catch((err) => {
                  this.logger.warn(`Failed to flush MySQL privileges: ${err instanceof Error ? err.message : String(err)}`);
                });
              }

              this.logger.log(`Successfully completed cleanup for database ${dbName} and user ${dbUser} on server ${server.id}`);
            } catch (dbErr) {
              this.logger.error(`Database/user deletion failed for env ${env.id}: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`);
            }
          }
        }

        // 3. Delete from DB (Prisma)
        this.logger.log(`EnvironmentDecommission job: Purging environment ${environmentId} from DB`);
        await this.prisma.environment.delete({
          where: { id: BigInt(environmentId) },
        });
      }

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "completed",
          completed_at: new Date(),
          progress: 100,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`EnvironmentDecommission job failed: ${msg}`);

      await this.prisma.jobExecution.update({
        where: { id: BigInt(jobExecutionId) },
        data: {
          status: "failed",
          last_error: msg,
          completed_at: new Date(),
        },
      });

      throw err;
    }
  }
}

