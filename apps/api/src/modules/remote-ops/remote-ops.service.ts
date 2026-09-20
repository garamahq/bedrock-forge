import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { basename, dirname } from "path";
import { Prisma } from "@prisma/client";
import { createRemoteExecutor } from "@bedrock-forge/remote-executor";
import { RemoteOpsRepository } from "./remote-ops.repository";
import { ServersService } from "../servers/servers.service";
import {
  CreateEnvTemplateDto,
  CreateResourceNoteDto,
  TouchRemotePathDto,
  UpdateResourceNoteDto,
  WriteEnvFileDto,
  WriteRemoteFileDto,
} from "./dto/remote-ops.dto";

const MAX_EDIT_BYTES = 256 * 1024;
const SECRET_KEY_RE =
  /(PASSWORD|PASS|SECRET|TOKEN|KEY|AUTH|SALT|PRIVATE|CLIENT_SECRET|DB_PASSWORD|API_KEY)/i;

type EnvPair = {
  key: string;
  value: string;
  masked_value: string;
  is_secret: boolean;
  line: number;
};

@Injectable()
export class RemoteOpsService {
  constructor(
    private readonly repo: RemoteOpsRepository,
    private readonly serversService: ServersService,
  ) {}

  async readEnvFile(envId: number, revealKey?: string, userId?: number) {
    const { content, checksum, env } = await this.readSafeTextFile(
      envId,
      ".env",
      MAX_EDIT_BYTES,
    );
    if (revealKey) {
      await this.repo.createAuditLog({
        user_id: userId ? BigInt(userId) : undefined,
        action: "env_file.secret_reveal",
        resource_type: "environment",
        resource_id: BigInt(envId),
        metadata: { key: revealKey },
      });
    }
    const variables = parseEnv(content).map((pair) =>
      this.maskEnvPair(pair, revealKey),
    );
    const templates = await this.repo.findTemplatesByEnvType(env.type);
    const requiredKeys = Array.from(
      new Set(templates.flatMap((t) => t.required_keys)),
    );
    const present = new Set(variables.map((v) => v.key));
    const missing_required = requiredKeys.filter((key) => !present.has(key));
    return {
      path: `${env.root_path}/.env`,
      checksum,
      content: maskEnvContent(content, revealKey),
      variables,
      missing_required,
      templates,
      confirmation_phrase: env.type,
    };
  }

  async writeEnvFile(
    envId: number,
    dto: WriteEnvFileDto,
    userId?: number,
  ) {
    const env = await this.requireEnvironment(envId);
    this.assertConfirmation(dto.confirmation, env.type);
    const current = await this.readSafeTextFile(envId, ".env", MAX_EDIT_BYTES);
    if (current.checksum !== dto.checksum) {
      throw new BadRequestException({
        message: "Remote file changed since it was loaded",
        current_checksum: current.checksum,
      });
    }
    const mergedContent = mergeMaskedEnvContent(dto.content, current.content);
    const validation = await this.validateEnvContent(env.type, mergedContent);
    if (validation.missing_required.length) {
      throw new BadRequestException({
        message: "Missing required environment variables",
        missing_required: validation.missing_required,
      });
    }
    const result = await this.writeSafeTextFile(envId, {
      path: ".env",
      content: mergedContent,
      checksum: dto.checksum,
      confirmation: dto.confirmation,
    });
    // Specific audit event for .env writes (more granular than the generic
    // AuditInterceptor environment.update that fires on every PUT)
    const changedKeys = detectChangedEnvKeys(current.content, mergedContent);
    await this.repo.createAuditLog({
      user_id: userId ? BigInt(userId) : undefined,
      action: "env_file.write",
      resource_type: "environment",
      resource_id: BigInt(envId),
      metadata: { changed_keys: changedKeys, path: ".env" },
    });
    return result;
  }

  async compareEnvFiles(
    projectId: number,
    leftEnvId: number,
    rightEnvId: number,
  ) {
    const [project, left, right] = await Promise.all([
      this.repo.findProjectById(projectId),
      this.readEnvFile(leftEnvId),
      this.readEnvFile(rightEnvId),
    ]);
    if (!project) throw new NotFoundException(`Project ${projectId} not found`);
    const [leftEnv, rightEnv] = await Promise.all([
      this.repo.findEnvironmentById(leftEnvId),
      this.repo.findEnvironmentById(rightEnvId),
    ]);
    if (
      !leftEnv ||
      !rightEnv ||
      leftEnv.project_id !== BigInt(projectId) ||
      rightEnv.project_id !== BigInt(projectId)
    ) {
      throw new BadRequestException("Both environments must belong to project");
    }
    const leftMap = new Map(left.variables.map((v) => [v.key, v]));
    const rightMap = new Map(right.variables.map((v) => [v.key, v]));
    const keys = Array.from(
      new Set([...leftMap.keys(), ...rightMap.keys()]),
    ).sort();
    return {
      left: { environment_id: leftEnvId, type: leftEnv.type },
      right: { environment_id: rightEnvId, type: rightEnv.type },
      rows: keys.map((key) => {
        const l = leftMap.get(key);
        const r = rightMap.get(key);
        return {
          key,
          left: l?.masked_value ?? null,
          right: r?.masked_value ?? null,
          is_secret: l?.is_secret ?? r?.is_secret ?? SECRET_KEY_RE.test(key),
          status: !l
            ? "missing_left"
            : !r
              ? "missing_right"
              : l.value === r.value
                ? "same"
                : "different",
        };
      }),
    };
  }

  async listFiles(envId: number, path?: string) {
    const { executor, env, safePath } = await this.resolveSafePath(envId, path);
    const cmd =
      `find ${q(safePath)} -maxdepth 1 -mindepth 1 ` +
      `-printf '%f\\t%y\\t%s\\t%m\\t%T@\\n' 2>/dev/null | sort`;
    const result = await executor.execute(cmd, { timeout: 20_000 });
    if (result.code !== 0) {
      throw new BadRequestException(
        result.stderr || "Unable to list directory",
      );
    }
    return {
      path: safePath,
      roots: this.getSafeRoots(env),
      items: result.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, kind, size, mode, modified] = line.split("\t");
          return {
            name,
            path: `${safePath.replace(/\/$/, "")}/${name}`,
            type: kind === "d" ? "directory" : "file",
            size: Number(size || 0),
            mode,
            modified_at: Number(modified || 0) * 1000,
          };
        }),
    };
  }

  async readFile(envId: number, path: string, maxBytes = MAX_EDIT_BYTES) {
    return this.readSafeTextFile(
      envId,
      path,
      Math.min(maxBytes, MAX_EDIT_BYTES),
    );
  }

  async writeFile(envId: number, dto: WriteRemoteFileDto) {
    return this.writeSafeTextFile(envId, dto);
  }

  async touchPath(envId: number, dto: TouchRemotePathDto) {
    const { executor, safePath } = await this.resolveSafePath(envId, dto.path);
    const cmd =
      dto.type === "directory"
        ? `mkdir -p ${q(safePath)}`
        : `mkdir -p ${q(dirname(safePath))} && touch ${q(safePath)}`;
    const result = await executor.execute(cmd, { timeout: 10_000 });
    if (result.code !== 0) {
      throw new BadRequestException(
        result.stderr || `Unable to create ${dto.type}`,
      );
    }
    return { success: true, path: safePath, type: dto.type };
  }

  async downloadFile(envId: number, path: string) {
    const { executor, safePath } = await this.resolveSafePath(envId, path);
    const stat = await executor.execute(
      `test -f ${q(safePath)} && stat -c '%s' ${q(safePath)} || echo missing`,
      { timeout: 10_000 },
    );
    if (stat.stdout.trim() === "missing") {
      throw new NotFoundException(`${safePath} does not exist`);
    }
    const size = Number(stat.stdout.trim());
    const maxDownloadBytes = 100 * 1024 * 1024; // 100 MB maximum for downloads
    if (!Number.isFinite(size) || size > maxDownloadBytes) {
      throw new BadRequestException(
        `File is too large to download (${size} bytes, max ${maxDownloadBytes})`,
      );
    }
    const buf = await executor.pullFile(safePath);
    return {
      path: safePath,
      filename: basename(safePath),
      encoding: "base64",
      content: buf.toString("base64"),
      sizeBytes: buf.length,
      checksum: checksum(buf),
    };
  }

  async tailFile(envId: number, path: string, lines: number) {
    const { executor, safePath } = await this.resolveSafePath(envId, path);
    const count = Math.min(Math.max(lines || 100, 1), 1000);
    const result = await executor.execute(
      `test -f ${q(safePath)} && tail -n ${count} ${q(safePath)} || true`,
      { timeout: 15_000 },
    );
    if (result.code !== 0) {
      throw new BadRequestException(result.stderr || "Unable to tail file");
    }
    return {
      path: safePath,
      lines: result.stdout
        .split("\n")
        .filter(
          (line, index, all) => index < all.length - 1 || line.length > 0,
        ),
      fetched_at: new Date().toISOString(),
    };
  }

  async archiveUploads(envId: number) {
    const env = await this.requireEnvironment(envId);
    const { executor, safePath } = await this.resolveSafePath(
      envId,
      `${env.root_path}/web/app/uploads`,
    );
    const backupDir = `${env.backup_path || `${env.root_path}/.forge-backups`}/downloads`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = `${backupDir}/uploads-${env.type}-${stamp}.tar.gz`;
    const cmd =
      `mkdir -p ${q(backupDir)} && ` +
      `tar -C ${q(safePath)} -czf ${q(archivePath)} .`;
    const result = await executor.execute(cmd, { timeout: 10 * 60_000 });
    if (result.code !== 0) {
      throw new BadRequestException(
        result.stderr || "Unable to archive uploads",
      );
    }
    return { success: true, archive_path: archivePath };
  }

  async getNotes(resourceType: string, resourceId: string) {
    this.assertResourceType(resourceType);
    return this.repo.findNotes(resourceType, resourceId);
  }

  async createNote(dto: CreateResourceNoteDto, userId?: number) {
    this.assertResourceType(dto.resource_type);
    await this.assertResourceExists(dto.resource_type, dto.resource_id);
    return this.repo.createNote({
      resource_type: dto.resource_type,
      resource_id: BigInt(dto.resource_id),
      body: dto.body.trim(),
      pinned: dto.pinned ?? false,
      created_by_id: userId ? BigInt(userId) : undefined,
    });
  }

  async updateNote(
    noteId: number,
    dto: UpdateResourceNoteDto,
    userId?: number,
    roles?: string[],
  ) {
    await this.assertNoteOwnership(noteId, userId, roles);
    return this.repo.updateNote(noteId, {
      ...(dto.body !== undefined ? { body: dto.body.trim() } : {}),
      ...(dto.pinned !== undefined ? { pinned: dto.pinned } : {}),
    });
  }

  async deleteNote(noteId: number, userId?: number, roles?: string[]) {
    await this.assertNoteOwnership(noteId, userId, roles);
    await this.repo.deleteNote(noteId);
    return { success: true };
  }

  listEnvTemplates() {
    return this.repo.findAllTemplates();
  }

  createEnvTemplate(dto: CreateEnvTemplateDto) {
    return this.repo.createTemplate({
      name: dto.name.trim(),
      environment_type: dto.environment_type?.trim() || null,
      required_keys: dto.required_keys.map((k) => k.trim()).filter(Boolean),
      secret_keys: (dto.secret_keys ?? [])
        .map((k) => k.trim())
        .filter(Boolean),
      defaults: dto.defaults as Prisma.InputJsonValue | undefined,
    });
  }

  async deleteEnvTemplate(id: number) {
    await this.repo.deleteTemplate(id);
    return { success: true };
  }

  private async readSafeTextFile(
    envId: number,
    path: string,
    maxBytes: number,
  ) {
    const { executor, env, safePath } = await this.resolveSafePath(envId, path);
    const stat = await executor.execute(
      `test -f ${q(safePath)} && stat -c '%s' ${q(safePath)} || echo missing`,
      { timeout: 10_000 },
    );
    if (stat.stdout.trim() === "missing") {
      throw new NotFoundException(`${safePath} does not exist`);
    }
    const size = Number(stat.stdout.trim());
    if (!Number.isFinite(size) || size > maxBytes) {
      throw new BadRequestException(
        `File is too large to edit (${size} bytes, max ${maxBytes})`,
      );
    }
    const mime = await executor.execute(`file -bi ${q(safePath)} || true`, {
      timeout: 10_000,
    });
    if (
      mime.stdout &&
      !/text|json|xml|x-empty|inode\/x-empty/i.test(mime.stdout)
    ) {
      throw new BadRequestException(
        `Binary files cannot be edited (${mime.stdout.trim()})`,
      );
    }
    const buf = await executor.pullFile(safePath);
    const content = buf.toString("utf8");
    return { path: safePath, content, checksum: checksum(content), env };
  }

  private async writeSafeTextFile(envId: number, dto: WriteRemoteFileDto) {
    const { executor, env, safePath } = await this.resolveSafePath(
      envId,
      dto.path,
    );
    this.assertConfirmation(dto.confirmation, env.type);
    if (Buffer.byteLength(dto.content, "utf8") > MAX_EDIT_BYTES) {
      throw new BadRequestException(
        `File exceeds ${MAX_EDIT_BYTES} byte edit limit`,
      );
    }
    const current = await this.readSafeTextFile(
      envId,
      dto.path,
      MAX_EDIT_BYTES,
    );
    if (current.checksum !== dto.checksum) {
      throw new BadRequestException({
        message: "Remote file changed since it was loaded",
        current_checksum: current.checksum,
      });
    }
    const backupDir = `${env.backup_path || `${env.root_path}/.forge-backups`}/file-edits`;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = `${backupDir}/${stamp}-${basename(safePath)}`;
    const backupResult = await executor.execute(
      `mkdir -p ${q(backupDir)} && cp ${q(safePath)} ${q(backupPath)}`,
      { timeout: 20_000 },
    );
    if (backupResult.code !== 0) {
      throw new BadRequestException(
        backupResult.stderr || "Unable to create remote backup",
      );
    }
    await executor.pushFile({
      remotePath: safePath,
      content: dto.content,
      mode: 0o600,
    });
    return {
      success: true,
      path: safePath,
      backup_path: backupPath,
      checksum: checksum(dto.content),
    };
  }

  private async validateEnvContent(environmentType: string, content: string) {
    const templates = await this.repo.findTemplatesForValidation(environmentType);
    const required = Array.from(
      new Set(templates.flatMap((t) => t.required_keys)),
    );
    const present = new Set(parseEnv(content).map((pair) => pair.key));
    return { missing_required: required.filter((key) => !present.has(key)) };
  }

  private maskEnvPair(pair: EnvPair, revealKey?: string) {
    const isSecret = pair.is_secret;
    return {
      ...pair,
      value: isSecret && pair.key !== revealKey ? "" : pair.value,
      masked_value:
        isSecret && pair.key !== revealKey
          ? maskSecret(pair.value)
          : pair.value,
    };
  }

  private async resolveSafePath(envId: number, inputPath?: string) {
    const env = await this.requireEnvironment(envId);
    const executor = createRemoteExecutor(
      await this.serversService.getServerSshConfig(Number(env.server.id)),
    );
    const requested =
      !inputPath || inputPath === "."
        ? env.root_path
        : inputPath.startsWith("/")
          ? inputPath
          : `${env.root_path.replace(/\/$/, "")}/${inputPath}`;
    const resolved = await executor.execute(`realpath -m ${q(requested)}`, {
      timeout: 10_000,
    });
    if (resolved.code !== 0) {
      throw new BadRequestException(
        resolved.stderr || "Unable to resolve path",
      );
    }
    const safePath = resolved.stdout.trim();
    const roots = [
      ...this.getSafeRoots(env).map((root) => root.path),
      `${env.root_path}/web/app/logs`,
      `${env.root_path}/storage/logs`,
    ]
      .filter(Boolean)
      .map((root) => root!.replace(/\/$/, ""));
    const allowed = roots.some(
      (root) => safePath === root || safePath.startsWith(`${root}/`),
    );
    if (!allowed) {
      throw new BadRequestException("Path is outside the safe file roots");
    }
    return { executor, env, safePath };
  }

  private getSafeRoots(env: { root_path: string; backup_path: string | null }) {
    const backupsPath = env.backup_path || `${env.root_path}/.forge-backups`;
    const downloadsPath = `${backupsPath}/downloads`;
    const snapshotsPath = `${backupsPath}/db-snapshots`;
    return [
      { key: "root", label: "Site Root", path: env.root_path },
      {
        key: "uploads",
        label: "Uploads",
        path: `${env.root_path}/web/app/uploads`,
      },
      { key: "logs", label: "Logs", path: `${env.root_path}/storage/logs` },
      { key: "snapshots", label: "DB Snapshots", path: snapshotsPath },
      { key: "downloads", label: "Downloads", path: downloadsPath },
      { key: "backups", label: "Backups", path: backupsPath },
    ];
  }

  private async requireEnvironment(envId: number) {
    const env = await this.repo.findEnvironmentWithServerAndProject(envId);
    if (!env) throw new NotFoundException(`Environment ${envId} not found`);
    if (!env.root_path) {
      throw new BadRequestException("Environment has no root path configured");
    }
    return env;
  }

  private assertConfirmation(actual: string, expected: string) {
    if (actual.trim() !== expected.trim()) {
      throw new BadRequestException(`Type "${expected}" to confirm`);
    }
  }

  private assertResourceType(resourceType: string) {
    if (!["project", "environment", "server"].includes(resourceType)) {
      throw new BadRequestException("Unsupported note resource type");
    }
  }

  private async assertResourceExists(resourceType: string, resourceId: string) {
    const exists = await this.repo.resourceExists(resourceType, resourceId);
    if (!exists) {
      throw new NotFoundException(`${resourceType} ${resourceId} not found`);
    }
  }

  /**
   * Owners (created_by_id) and ADMINs may mutate notes.
   * Any other authenticated MANAGER is forbidden.
   */
  private async assertNoteOwnership(
    noteId: number,
    userId?: number,
    roles?: string[],
  ) {
    const note = await this.repo.findNoteById(noteId);
    if (!note) throw new NotFoundException(`Note ${noteId} not found`);
    const isAdmin =
      roles?.includes("admin") || roles?.includes("ADMIN") || false;
    if (isAdmin) return; // admins can manage all notes
    if (!userId) throw new ForbiddenException("Authentication required");
    if (note.created_by_id === null || Number(note.created_by_id) !== userId) {
      throw new ForbiddenException("You do not have permission to modify this note");
    }
  }
}

function parseEnv(content: string): EnvPair[] {
  return content.split(/\r?\n/).flatMap((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("="))
      return [];
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    return [
      {
        key,
        value,
        masked_value: value,
        is_secret: SECRET_KEY_RE.test(key),
        line: index + 1,
      },
    ];
  });
}

function maskEnvContent(content: string, revealKey?: string): string {
  return content
    .split(/\r?\n/)
    .map((line) => {
      if (!line.includes("=")) return line;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      if (!SECRET_KEY_RE.test(key) || key === revealKey) return line;
      return `${line.slice(0, eq + 1)}${maskSecret(line.slice(eq + 1).trim())}`;
    })
    .join("\n");
}

function mergeMaskedEnvContent(edited: string, current: string): string {
  const currentValues = new Map(
    parseEnv(current).map((pair) => [pair.key, pair.value]),
  );
  return edited
    .split(/\r?\n/)
    .map((line) => {
      if (!line.includes("=")) return line;
      const eq = line.indexOf("=");
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (!SECRET_KEY_RE.test(key) || !value.includes("****")) return line;
      const currentValue = currentValues.get(key);
      if (currentValue === undefined) return line;
      return `${line.slice(0, eq + 1)}${quoteEnvValue(currentValue)}`;
    })
    .join("\n");
}

function quoteEnvValue(value: string): string {
  if (/[\s"'#]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

function maskSecret(value: string): string {
  const unquoted = value.replace(/^['"]|['"]$/g, "");
  if (!unquoted) return "";
  if (unquoted.length <= 4) return "****";
  return `${unquoted.slice(0, 2)}****${unquoted.slice(-2)}`;
}

function checksum(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function q(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * Returns the list of .env variable keys whose values changed between two
 * content strings. Values are never logged — only key names are reported.
 */
function detectChangedEnvKeys(before: string, after: string): string[] {
  const beforeMap = new Map(parseEnv(before).map((p) => [p.key, p.value]));
  const afterMap = new Map(parseEnv(after).map((p) => [p.key, p.value]));
  const changed: string[] = [];
  for (const [key, value] of afterMap) {
    if (beforeMap.get(key) !== value) changed.push(key);
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) changed.push(key);
  }
  return [...new Set(changed)].sort();
}
