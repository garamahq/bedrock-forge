import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { ServersRepository } from "./servers.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";
import { SettingsService } from "../settings/settings.service";
import {
  createRemoteExecutor,
  credentialParser,
  SshServerConfig,
} from "@bedrock-forge/remote-executor";
import { CreateServerDto, UpdateServerDto } from "./dto/server.dto";
import {
  DetectBedrockDto,
  BedrockDetectionResult,
} from "./dto/detect-bedrock.dto";
import { ScannedProject, ScanProjectsMultiDto } from "./dto/scan-projects.dto";

@Injectable()
export class ServersService {
  private readonly logger = new Logger(ServersService.name);

  constructor(
    private readonly repo: ServersRepository,
    private readonly enc: EncryptionService,
    private readonly settings: SettingsService,
  ) {}

  findAll(opts: { page?: number; limit?: number; search?: string } = {}) {
    return this.repo.findAll(opts);
  }

  async findOne(id: number) {
    const server = await this.repo.findById(BigInt(id));
    if (!server) throw new NotFoundException(`Server ${id} not found`);
    return server;
  }

  create(dto: CreateServerDto) {
    return this.repo.create(dto);
  }

  async update(id: number, dto: UpdateServerDto) {
    await this.findOne(id);
    return this.repo.update(BigInt(id), dto);
  }

  async remove(id: number) {
    const server = await this.findOne(id);
    const count = await this.repo.countEnvironments(BigInt(id));
    if (count > 0) {
      throw new BadRequestException(
        `Cannot delete server "${server.name}" because it is linked to ${count} active environment(s). ` +
          "Decommission or delete the associated projects/environments first.",
      );
    }
    return this.repo.delete(BigInt(id));
  }

  /**
   * Resolve a usable SSH private key for the given server.
   * 1. Decrypt the per-server key and validate it is a real PEM/OpenSSH key.
   * 2. If the per-server key is missing, decryption fails, or the decrypted
   *    value is not a valid key (e.g. the seed placeholder "REPLACE_ME"),
   *    fall back to the global SSH key from Settings.
   * 3. Throw BadRequestException if neither source yields a valid key.
   */
  private async resolvePrivateKey(server: {
    name: string;
    ssh_private_key_encrypted: string;
  }): Promise<string> {
    if (server.ssh_private_key_encrypted) {
      try {
        const decrypted = this.enc.decrypt(server.ssh_private_key_encrypted);
        if (decrypted && decrypted.trimStart().startsWith("-----BEGIN")) {
          return decrypted;
        }
      } catch {
        // Decryption failed (wrong ENCRYPTION_KEY or corrupted) — try global
      }
    }

    const globalKey = await this.settings.getDecrypted(
      "global_ssh_private_key",
    );
    if (globalKey && globalKey.trimStart().startsWith("-----BEGIN")) {
      return globalKey;
    }

    throw new BadRequestException(
      `No valid SSH key available for server "${server.name}". ` +
        "Set a PEM-formatted private key on the server edit page, " +
        "or configure a global SSH key in Settings → SSH Key.",
    );
  }

  /**
   * Return a ready-to-use SSH configuration for the given server.
   * Resolves the appropriate private key (per-server or global fallback).
   * Used by other services that need to open SSH connections.
   */
  async getServerSshConfig(serverId: number): Promise<SshServerConfig> {
    const server = await this.repo.findByIdWithKey(BigInt(serverId));
    if (!server) throw new NotFoundException(`Server ${serverId} not found`);
    const privateKey = await this.resolvePrivateKey(server);
    return {
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey,
      expectedHostKeyFingerprint: server.host_key_fingerprint ?? undefined,
      onHostKeyFingerprint: async (fingerprint) => {
        await this.repo.updateHostKeyFingerprint(BigInt(serverId), fingerprint);
      },
    };
  }

  /** Execute a quick `echo ok` to verify SSH connectivity, and probe CyberPanel version */
  async testConnection(id: number): Promise<{
    success: boolean;
    message: string;
    cyberpanelVersion?: string;
  }> {
    const server = await this.repo.findByIdWithKey(BigInt(id));
    if (!server) throw new NotFoundException(`Server ${id} not found`);

    const privateKey = await this.resolvePrivateKey(server);

    const executor = createRemoteExecutor({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_user,
      privateKey,
      expectedHostKeyFingerprint: server.host_key_fingerprint ?? undefined,
      onHostKeyFingerprint: async (fingerprint) => {
        await this.repo.updateHostKeyFingerprint(server.id, fingerprint);
      },
    });

    try {
      const result = await executor.execute("echo ok");
      const success = result.code === 0;
      await this.repo.updateStatus(BigInt(id), success ? "online" : "offline");

      let cyberpanelVersion: string | undefined;
      if (success) {
        try {
          const versionResult = await executor.execute(
            "cat /usr/local/CyberCP/version.txt 2>/dev/null || echo ''",
          );
          const detected = versionResult.stdout.trim();
          if (detected) {
            cyberpanelVersion = detected;
            await this.repo
              .updateCyberPanelVersion(BigInt(id), detected)
              .catch(() => {});
          } else {
            // CyberPanel not installed — clear any stale version
            await this.repo
              .updateCyberPanelVersion(BigInt(id), null)
              .catch(() => {});
          }
        } catch {
          // Version detection is non-critical — ignore failures
        }
      }

      return { success, message: result.stdout.trim(), cyberpanelVersion };
    } catch (err: unknown) {
      await this.repo.updateStatus(BigInt(id), "offline").catch(() => {});
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * SSH into a server, probe the given path, and decide if it is a Bedrock WP install.
   * Returns structured detection results including DB credentials parsed from .env.
   */
  async detectBedrock(
    id: number,
    path: string,
  ): Promise<BedrockDetectionResult> {
    const server = await this.repo.findByIdWithKey(BigInt(id));
    if (!server) throw new NotFoundException(`Server ${id} not found`);

    const executor = createRemoteExecutor(
      await this.getServerSshConfig(id),
    );

    const rootPath = path.endsWith("/") ? path.slice(0, -1) : path;

    // Check existence of key files
    const checkFile = async (filePath: string): Promise<boolean> => {
      try {
        const r = await executor.execute(
          `test -f "${filePath}" && echo found || echo missing`,
        );
        return r.stdout.trim() === "found";
      } catch {
        return false;
      }
    };

    const readFile = async (filePath: string): Promise<string | null> => {
      try {
        const r = await executor.execute(`cat "${filePath}"`);
        return r.code === 0 ? r.stdout : null;
      } catch {
        return null;
      }
    };

    const [hasComposer, hasAppConfig, hasEnvFile, hasWpConfig] =
      await Promise.all([
        checkFile(`${rootPath}/composer.json`),
        checkFile(`${rootPath}/config/application.php`),
        checkFile(`${rootPath}/.env`),
        checkFile(`${rootPath}/web/wp-config.php`),
      ]);

    const isBedrock = hasAppConfig || (hasComposer && hasEnvFile);
    const isWordPress = hasWpConfig || isBedrock;

    // Parse composer.json for project name
    let composerJson: Record<string, unknown> | undefined;
    let projectName = rootPath.split("/").pop() ?? "Unknown";
    if (hasComposer) {
      const raw = await readFile(`${rootPath}/composer.json`);
      if (raw) {
        try {
          composerJson = JSON.parse(raw) as Record<string, unknown>;
          if (typeof composerJson["name"] === "string") {
            projectName = composerJson["name"].split("/").pop() ?? projectName;
          }
        } catch {
          /* ignore */
        }
      }
    }

    // Parse .env for DB credentials and WP_HOME
    let dbCredentials: BedrockDetectionResult["dbCredentials"];
    let siteUrl: string | undefined;
    if (hasEnvFile) {
      const raw = await readFile(`${rootPath}/.env`);
      if (raw) {
        const creds = credentialParser.parseEnvFile(raw);
        if (creds) {
          dbCredentials = {
            dbName: creds.dbName,
            dbUser: creds.dbUser,
            dbPassword: creds.dbPassword,
            dbHost: creds.dbHost,
          };
        }
        // Extract WP_HOME from .env lines
        const homeLine = raw.split("\n").find((l) => l.startsWith("WP_HOME="));
        if (homeLine)
          siteUrl = homeLine.split("=")[1]?.trim().replace(/["']/g, "");
      }
    }

    // Fallback: try config/application.php if no DB creds yet
    if (!dbCredentials && hasAppConfig) {
      const raw = await readFile(`${rootPath}/config/application.php`);
      if (raw) {
        const creds = credentialParser.parse(raw);
        if (creds) {
          dbCredentials = {
            dbName: creds.dbName,
            dbUser: creds.dbUser,
            dbPassword: creds.dbPassword,
            dbHost: creds.dbHost,
          };
        }
      }
    }

    return {
      isBedrock,
      isWordPress,
      projectName,
      siteUrl,
      dbCredentials,
      composerJson,
      detectedPaths: {
        config: hasAppConfig ? `${rootPath}/config/application.php` : "",
        webRoot: hasWpConfig ? `${rootPath}/web` : rootPath,
      },
    };
  }

  // SSH into a server, run one shell command that iterates /home/{user}/public_html,
  // parses .env / wp-config.php for each site, and returns structured results.
  // Deduplicates against existing Environment records in the DB.
  async scanProjects(id: number): Promise<ScannedProject[]> {
    const server = await this.repo.findByIdWithKey(BigInt(id));
    if (!server) throw new NotFoundException(`Server ${id} not found`);

    const executor = createRemoteExecutor(
      await this.getServerSshConfig(id),
    );

    // Single SSH command: iterate /home/*/public_html, emit delimited blocks
    const scanCmd = [
      `for dir in /home/*/public_html; do`,
      `  [ -d "$dir" ] || continue;`,
      `  [ -f "$dir/.env" ] || [ -f "$dir/wp-config.php" ] || [ -f "$dir/web/wp-config.php" ] || continue;`,
      `  echo '===START===';`,
      `  echo "PATH=$dir";`,
      `  if [ -f "$dir/composer.json" ]; then echo '===COMPOSER==='; head -c 10240 "$dir/composer.json"; fi;`,
      `  if [ -f "$dir/.env" ]; then echo '===ENV==='; head -c 10240 "$dir/.env"; fi;`,
      `  if [ -f "$dir/web/wp-config.php" ]; then echo '===WPCONFIG==='; head -c 10240 "$dir/web/wp-config.php"; fi;`,
      `  if [ -f "$dir/wp-config.php" ]; then echo '===WPCONFIG==='; head -c 10240 "$dir/wp-config.php"; fi;`,
      `  echo '===END===';`,
      `done`,
    ].join(" ");

    let raw: string;
    try {
      const result = await executor.execute(scanCmd, { timeout: 60_000 });
      raw = result.stdout;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `SSH scan failed for server "${server.name}": ${msg}`,
      );
    }

    // Split output into per-project blocks
    const blocks = raw.split("===START===").slice(1);
    const discovered: Array<{
      path: string;
      name: string;
      isBedrock: boolean;
      isWordPress: boolean;
      siteUrl?: string;
      mainDomain?: string;
      dbCredentials?: ScannedProject["dbCredentials"];
    }> = [];

    for (const block of blocks) {
      const endIdx = block.indexOf("===END===");
      const content = endIdx >= 0 ? block.slice(0, endIdx) : block;

      // Extract PATH
      const pathMatch = content.match(/^PATH=(.+)/m);
      if (!pathMatch) continue;
      const sitePath = pathMatch[1].trim();

      // Extract sections
      const composerRaw = this.extractSection(content, "COMPOSER");
      const envRaw = this.extractSection(content, "ENV");
      const wpConfigRaw = this.extractSection(content, "WPCONFIG");

      // Determine site type
      const hasComposer = composerRaw !== null;
      const hasEnv = envRaw !== null;
      const hasWpConfig = wpConfigRaw !== null;
      const isBedrock =
        hasEnv && (hasComposer || content.includes("application.php"));
      const isWordPress = hasWpConfig || isBedrock;

      if (!isWordPress) continue;

      // Derive project name: prefer domain from siteUrl, fall back to composer/dir
      let name =
        sitePath.split("/").filter(Boolean).slice(-2, -1)[0] ??
        sitePath.split("/").pop() ??
        "Unknown";
      if (composerRaw) {
        try {
          const pkg = JSON.parse(composerRaw) as Record<string, unknown>;
          if (typeof pkg["name"] === "string") {
            name = pkg["name"].split("/").pop() ?? name;
          }
        } catch {
          /* ignore */
        }
      }

      // Parse DB credentials and extract siteUrl
      let dbCredentials: ScannedProject["dbCredentials"];
      let siteUrl: string | undefined;

      if (envRaw) {
        const creds = credentialParser.parseEnvFile(envRaw);
        if (creds) dbCredentials = creds;
        const homeLine = envRaw
          .split("\n")
          .find((l) => l.startsWith("WP_HOME=") || l.startsWith("SITE_URL="));
        if (homeLine) {
          siteUrl = homeLine
            .split("=")
            .slice(1)
            .join("=")
            .trim()
            .replace(/["']/g, "");
        }
      }
      if (!dbCredentials && wpConfigRaw) {
        const creds = credentialParser.parse(wpConfigRaw);
        if (creds) dbCredentials = creds;
      }

      // Prefer the site URL hostname as the project name (e.g. example.com)
      let mainDomain: string | undefined;
      if (siteUrl) {
        try {
          const hostname = new URL(siteUrl).hostname.toLowerCase();
          if (hostname) name = hostname;
          mainDomain = this.extractMainDomain(hostname);
          // Only set mainDomain when it actually differs from hostname
          if (mainDomain === hostname) mainDomain = undefined;
        } catch {
          /* ignore malformed URL */
        }
      }

      discovered.push({
        path: sitePath,
        name,
        isBedrock,
        isWordPress,
        siteUrl,
        dbCredentials,
        mainDomain,
      });
    }

    // Dedup: find which paths already exist as environments on this server
    const allPaths = discovered.map((d) => d.path);
    const existing = await this.repo.findExistingEnvironmentPaths(
      BigInt(id),
      allPaths,
    );
    const existingMap = new Map(
      existing.map((e) => [e.root_path, e.project_id.toString()]),
    );

    return discovered.map((d) => ({
      ...d,
      hasDbCredentials: d.dbCredentials !== undefined,
      alreadyImported: existingMap.has(d.path),
      existingProjectId: existingMap.get(d.path),
      serverId: id,
      serverName: server.name,
    }));
  }

  /**
   * Scan multiple servers in parallel and merge results.
   * Uses Promise.allSettled so a single failing server does not abort the rest.
   */
  async scanProjectsMulti(
    dto: ScanProjectsMultiDto,
  ): Promise<ScannedProject[]> {
    const results = await Promise.allSettled(
      dto.serverIds.map((sid) => this.scanProjects(sid)),
    );
    const merged: ScannedProject[] = [];
    const errors: string[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        merged.push(...result.value);
      } else {
        const msg =
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason);
        this.logger.warn(`[scanProjectsMulti] Server scan failed: ${msg}`);
        errors.push(msg);
      }
    }
    // If every server failed, surface the errors instead of returning empty
    if (merged.length === 0 && errors.length > 0) {
      throw new BadRequestException(errors.join(" | "));
    }
    return merged;
  }

  /** Extract the registrable root domain (last two labels, or last three for
   *  known multi-part second-level TLDs like .co.uk).
   */
  private extractMainDomain(hostname: string): string {
    const MULTI_TLD = new Set([
      "co.uk",
      "com.au",
      "co.nz",
      "org.uk",
      "net.au",
      "co.za",
    ]);
    const parts = hostname.split(".");
    if (parts.length <= 2) return hostname;
    const twoLabel = parts.slice(-2).join(".");
    if (MULTI_TLD.has(twoLabel)) return parts.slice(-3).join(".");
    return twoLabel;
  }

  /** Extract the content of a ===MARKER=== section from a scan block */
  private extractSection(block: string, marker: string): string | null {
    const startTag = `===${marker}===`;
    const startIdx = block.indexOf(startTag);
    if (startIdx < 0) return null;
    const after = block.slice(startIdx + startTag.length);
    // End at the next ===...=== marker or ===END===
    const nextMarker = after.search(/===\w+===/);
    const content = nextMarker >= 0 ? after.slice(0, nextMarker) : after;
    return content.trim() || null;
  }

  // ── SSH Pool Health ───────────────────────────────────────────────────────

  getSshPoolHealth(serverId: number): {
    active: number;
    idle: number;
    total: number;
    maxConnections: number;
    status: "healthy" | "busy" | "empty";
  } {
    // sshPoolManager is the process-global singleton in remote-executor
    const { sshPoolManager } = require("@bedrock-forge/remote-executor") as {
      sshPoolManager: {
        getPoolStats: (key: string) => {
          active: number;
          idle: number;
          total: number;
          maxConnections: number;
        };
      };
    };
    const stats = sshPoolManager.getPoolStats(String(serverId));
    let status: "healthy" | "busy" | "empty" = "healthy";
    if (stats.total === 0) status = "empty";
    else if (stats.active >= stats.maxConnections) status = "busy";
    return { ...stats, status };
  }

  // ── Server Resource Monitoring & Live Stats ────────────────────────────────

  async getServerStats(id: number): Promise<{
    cpu_usage: number | null;
    memory_used_mb: number | null;
    memory_total_mb: number | null;
    disk_used_gb: number | null;
    disk_total_gb: number | null;
    uptime_seconds: number | null;
    load_average: [number, number, number] | null;
    ping_ms: number | null;
    top_processes: Array<{
      pid: string;
      user: string;
      cpu: string;
      mem: string;
      command: string;
    }>;
    alerts: Array<{
      type: "cpu" | "memory" | "disk" | "offline";
      level: "warning" | "critical";
      message: string;
    }>;
  }> {
    const server = await this.repo.findByIdWithKey(BigInt(id));
    if (!server) throw new NotFoundException(`Server ${id} not found`);

    let pingMs: number | null = null;
    const t0 = Date.now();

    try {
      const executor = createRemoteExecutor(await this.getServerSshConfig(id));

      const probeCmd = [
        "echo '===CPU==='",
        "top -bn1 2>/dev/null | grep -E 'Cpu\\(s\\)|%Cpu' | head -n1 || grep 'cpu ' /proc/stat | head -n1",
        "echo '===MEM==='",
        "free -m 2>/dev/null | grep -E 'Mem:|buffers/cache' || cat /proc/meminfo | head -n 4",
        "echo '===DISK==='",
        "df -m / 2>/dev/null | awk 'NR==2{print $2,$3,$4,$5}'",
        "echo '===UPTIME==='",
        "cat /proc/uptime 2>/dev/null",
        "echo '===LOAD==='",
        "cat /proc/loadavg 2>/dev/null",
        "echo '===PROCS==='",
        "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu 2>/dev/null | head -n 6",
      ].join("; ");

      const result = await executor.execute(probeCmd, { timeout: 15_000 });
      pingMs = Date.now() - t0;

      if (result.code !== 0) {
        throw new Error(`Probe exited with code ${result.code}`);
      }

      await this.repo.updateStatus(BigInt(id), "online").catch(() => {});

      const raw = result.stdout;
      const cpuSection = this.extractSection(raw, "CPU") || "";
      const memSection = this.extractSection(raw, "MEM") || "";
      const diskSection = this.extractSection(raw, "DISK") || "";
      const uptimeSection = this.extractSection(raw, "UPTIME") || "";
      const loadSection = this.extractSection(raw, "LOAD") || "";
      const procsSection = this.extractSection(raw, "PROCS") || "";

      // 1. CPU Usage %
      let cpuUsage: number | null = null;
      const cpuMatch = cpuSection.match(/([\d.]+)\s*id/i) || cpuSection.match(/,\s*([\d.]+)\s*id/i);
      if (cpuMatch) {
        const idle = parseFloat(cpuMatch[1]);
        if (!isNaN(idle)) cpuUsage = Math.max(0, Math.min(100, Math.round((100 - idle) * 10) / 10));
      } else {
        const altCpuMatch = cpuSection.match(/([\d.]+)\s*us[,\s]+([\d.]+)\s*sy/i);
        if (altCpuMatch) {
          const us = parseFloat(altCpuMatch[1]);
          const sy = parseFloat(altCpuMatch[2]);
          if (!isNaN(us) && !isNaN(sy)) {
            cpuUsage = Math.max(0, Math.min(100, Math.round((us + sy) * 10) / 10));
          }
        }
      }

      // 2. Memory (Used MB / Total MB)
      let memUsedMb: number | null = null;
      let memTotalMb: number | null = null;
      const memLineMatch = memSection.match(/Mem:\s+(\d+)\s+(\d+)/);
      if (memLineMatch) {
        memTotalMb = parseInt(memLineMatch[1], 10);
        memUsedMb = parseInt(memLineMatch[2], 10);
      } else {
        const totalKb = memSection.match(/MemTotal:\s+(\d+)/);
        const freeKb = memSection.match(/MemAvailable:\s+(\d+)/) || memSection.match(/MemFree:\s+(\d+)/);
        if (totalKb && freeKb) {
          memTotalMb = Math.round(parseInt(totalKb[1], 10) / 1024);
          const availMb = Math.round(parseInt(freeKb[1], 10) / 1024);
          memUsedMb = Math.max(0, memTotalMb - availMb);
        }
      }

      // 3. Disk (Used GB / Total GB)
      let diskUsedGb: number | null = null;
      let diskTotalGb: number | null = null;
      const diskParts = diskSection.trim().split(/\s+/);
      if (diskParts.length >= 2) {
        const totalM = parseFloat(diskParts[0]);
        const usedM = parseFloat(diskParts[1]);
        if (!isNaN(totalM) && !isNaN(usedM)) {
          diskTotalGb = Math.round((totalM / 1024) * 10) / 10;
          diskUsedGb = Math.round((usedM / 1024) * 10) / 10;
        }
      }

      // 4. Uptime Seconds
      let uptimeSeconds: number | null = null;
      const uptimeMatch = uptimeSection.match(/^([\d.]+)/);
      if (uptimeMatch) {
        uptimeSeconds = Math.floor(parseFloat(uptimeMatch[1]));
      }

      // 5. Load Average
      let loadAvg: [number, number, number] | null = null;
      const loadParts = loadSection.trim().split(/\s+/);
      if (loadParts.length >= 3) {
        const l1 = parseFloat(loadParts[0]);
        const l5 = parseFloat(loadParts[1]);
        const l15 = parseFloat(loadParts[2]);
        if (!isNaN(l1) && !isNaN(l5) && !isNaN(l15)) {
          loadAvg = [l1, l5, l15];
        }
      }

      // 6. Top Processes
      const topProcesses: Array<{
        pid: string;
        user: string;
        cpu: string;
        mem: string;
        command: string;
      }> = [];
      const procLines = procsSection.trim().split("\n").slice(1);
      for (const line of procLines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5) {
          topProcesses.push({
            pid: parts[0],
            user: parts[1],
            cpu: parts[2] + "%",
            mem: parts[3] + "%",
            command: parts.slice(4).join(" "),
          });
        }
      }

      // 7. Alert checks
      const alerts: Array<{
        type: "cpu" | "memory" | "disk" | "offline";
        level: "warning" | "critical";
        message: string;
      }> = [];

      if (cpuUsage !== null) {
        if (cpuUsage >= 90) {
          alerts.push({
            type: "cpu",
            level: "critical",
            message: `CPU usage is critically high at ${cpuUsage}%! Check running processes.`,
          });
        } else if (cpuUsage >= 75) {
          alerts.push({
            type: "cpu",
            level: "warning",
            message: `CPU usage is elevated at ${cpuUsage}%.`,
          });
        }
      }

      if (memUsedMb !== null && memTotalMb !== null && memTotalMb > 0) {
        const memPct = Math.round((memUsedMb / memTotalMb) * 100);
        if (memPct >= 90) {
          alerts.push({
            type: "memory",
            level: "critical",
            message: `Memory usage is critically high at ${memPct}% (${Math.round(memUsedMb / 1024)}GB / ${Math.round(memTotalMb / 1024)}GB).`,
          });
        } else if (memPct >= 80) {
          alerts.push({
            type: "memory",
            level: "warning",
            message: `Memory usage is high at ${memPct}%.`,
          });
        }
      }

      if (diskUsedGb !== null && diskTotalGb !== null && diskTotalGb > 0) {
        const diskPct = Math.round((diskUsedGb / diskTotalGb) * 100);
        if (diskPct >= 90) {
          alerts.push({
            type: "disk",
            level: "critical",
            message: `Root disk is ${diskPct}% full (${diskUsedGb}GB / ${diskTotalGb}GB)! Free space immediately.`,
          });
        } else if (diskPct >= 80) {
          alerts.push({
            type: "disk",
            level: "warning",
            message: `Root disk is ${diskPct}% full.`,
          });
        }
      }

      // Record snapshot to database asynchronously
      this.repo
        .recordMetric(BigInt(id), {
          cpu_usage: cpuUsage,
          memory_used_mb: memUsedMb,
          memory_total_mb: memTotalMb,
          disk_used_gb: diskUsedGb,
          disk_total_gb: diskTotalGb,
          uptime_seconds: uptimeSeconds,
          load_1m: loadAvg ? loadAvg[0] : null,
          load_5m: loadAvg ? loadAvg[1] : null,
          load_15m: loadAvg ? loadAvg[2] : null,
          ping_ms: pingMs,
        })
        .catch((err) => {
          this.logger.warn(`Failed to record server metric: ${err.message}`);
        });

      return {
        cpu_usage: cpuUsage,
        memory_used_mb: memUsedMb,
        memory_total_mb: memTotalMb,
        disk_used_gb: diskUsedGb,
        disk_total_gb: diskTotalGb,
        uptime_seconds: uptimeSeconds,
        load_average: loadAvg,
        ping_ms: pingMs,
        top_processes: topProcesses,
        alerts,
      };
    } catch (err: unknown) {
      this.logger.warn(
        `Failed to probe server stats for server ${id}: ${err instanceof Error ? err.message : String(err)}`,
      );

      // Fallback: return last known metric from database if probe failed
      const lastMetric = await this.repo.getLatestMetric(BigInt(id)).catch(() => null);

      return {
        cpu_usage: lastMetric?.cpu_usage ?? null,
        memory_used_mb: lastMetric?.memory_used_mb ?? null,
        memory_total_mb: lastMetric?.memory_total_mb ?? null,
        disk_used_gb: lastMetric?.disk_used_gb ?? null,
        disk_total_gb: lastMetric?.disk_total_gb ?? null,
        uptime_seconds: lastMetric?.uptime_seconds ?? null,
        load_average:
          lastMetric?.load_1m !== null &&
          lastMetric?.load_5m !== null &&
          lastMetric?.load_15m !== null &&
          lastMetric?.load_1m !== undefined &&
          lastMetric?.load_5m !== undefined &&
          lastMetric?.load_15m !== undefined
            ? [lastMetric.load_1m, lastMetric.load_5m, lastMetric.load_15m]
            : null,
        ping_ms: null,
        top_processes: [],
        alerts: [
          {
            type: "offline",
            level: "critical",
            message: `Server probe failed: ${err instanceof Error ? err.message : "Connection unreachable"}`,
          },
        ],
      };
    }
  }

  async getServerMetricsHistory(
    id: number,
    range: "1h" | "24h" | "7d" = "24h",
  ): Promise<
    Array<{
      timestamp: string;
      cpu_usage: number | null;
      memory_pct: number | null;
      disk_pct: number | null;
      load_1m: number | null;
      ping_ms: number | null;
    }>
  > {
    await this.findOne(id);

    const now = Date.now();
    let ms = 24 * 60 * 60 * 1000;
    if (range === "1h") ms = 60 * 60 * 1000;
    else if (range === "7d") ms = 7 * 24 * 60 * 60 * 1000;

    const since = new Date(now - ms);
    const metrics = await this.repo.getMetricsHistory(BigInt(id), since);

    return metrics.map((m) => {
      const memPct =
        m.memory_used_mb && m.memory_total_mb
          ? Math.round((m.memory_used_mb / m.memory_total_mb) * 100)
          : null;
      const diskPct =
        m.disk_used_gb && m.disk_total_gb
          ? Math.round((m.disk_used_gb / m.disk_total_gb) * 100)
          : null;

      return {
        timestamp: m.recorded_at.toISOString(),
        cpu_usage: m.cpu_usage,
        memory_pct: memPct,
        disk_pct: diskPct,
        load_1m: m.load_1m,
        ping_ms: m.ping_ms,
      };
    });
  }

  async testPing(id: number): Promise<{
    latencyMs: number;
    success: boolean;
    message: string;
  }> {
    const t0 = Date.now();
    try {
      const conn = await this.testConnection(id);
      const latencyMs = Date.now() - t0;
      return {
        latencyMs,
        success: conn.success,
        message: conn.success ? `Ping successful (${latencyMs}ms)` : conn.message,
      };
    } catch (err: unknown) {
      return {
        latencyMs: Date.now() - t0,
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
