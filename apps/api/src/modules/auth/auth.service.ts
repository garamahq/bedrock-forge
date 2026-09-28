import {
  Injectable,
  UnauthorizedException,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import * as crypto from "crypto";
import * as QRCode from "qrcode";
import { AuthRepository } from "./auth.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: {
    id: number;
    email: string;
    name: string;
    roles: string[];
    mfa_enabled: boolean;
  };
}

@Injectable()
export class AuthService {
  constructor(
    private readonly repo: AuthRepository,
    private readonly jwtService: JwtService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
  ) {}

  /** Maximum consecutive login failures before locking the account. */
  private readonly MAX_LOGIN_FAILURES = 10;
  /** Lock duration in milliseconds (30 minutes). */
  private readonly LOCKOUT_DURATION_MS = 30 * 60_000;

  async login(
    email: string,
    password: string,
    code?: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<TokenPair | { mfaRequired: boolean }> {
    const user = await this.repo.findUserByEmail(email);
    if (!user) {
      throw new UnauthorizedException("Invalid credentials");
    }

    // ── Account lockout check ──────────────────────────────────────────────
    if (user.locked_until && user.locked_until > new Date()) {
      const minutesLeft = Math.ceil(
        (user.locked_until.getTime() - Date.now()) / 60_000,
      );
      throw new UnauthorizedException(
        `Account locked due to too many failed attempts. Try again in ${minutesLeft} minute(s).`,
      );
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      // Increment failure counter; lock if threshold reached
      const failures = user.login_failures + 1;
      const lockedUntil =
        failures >= this.MAX_LOGIN_FAILURES
          ? new Date(Date.now() + this.LOCKOUT_DURATION_MS)
          : null;
      await this.repo.recordLoginFailure(user.id, failures, lockedUntil);
      throw new UnauthorizedException("Invalid credentials");
    }

    // ── Reset failure counter on successful password check ─────────────────
    if (user.login_failures > 0 || user.locked_until) {
      await this.repo.resetLoginFailures(user.id);
    }

    if (user.mfa_enabled) {
      if (!code) {
        return { mfaRequired: true };
      }
      if (!user.totp_secret_encrypted) {
        throw new UnauthorizedException("MFA configuration error");
      }
      const secret = this.encryption.decrypt(user.totp_secret_encrypted);
      const matchedStep = this.verifyTOTP(secret, code);
      if (matchedStep === null) {
        throw new UnauthorizedException("Invalid MFA code");
      }
      if (
        user.last_totp_step !== null &&
        BigInt(matchedStep) <= user.last_totp_step
      ) {
        throw new UnauthorizedException("MFA code has already been used");
      }
      await this.repo.updateLastTotpStep(user.id, BigInt(matchedStep));
    }

    const roles = user.user_roles.map((userRole) => userRole.role.name);
    return this.issueTokens(
      Number(user.id),
      user.email,
      user.name,
      roles,
      user.mfa_enabled,
      userAgent,
      ipAddress,
    );
  }

  async refresh(
    refreshToken: string,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<TokenPair> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.repo.findValidRefreshToken(tokenHash);

    if (!stored) {
      throw new UnauthorizedException("Invalid or expired refresh token");
    }

    // Rotate: revoke old, issue new
    await this.repo.revokeRefreshToken(stored.id);

    const user = await this.repo.findUserById(Number(stored.user_id));
    if (!user) {
      throw new NotFoundException("User not found");
    }

    const roles = user.user_roles.map((ur) => ur.role.name);
    return this.issueTokens(
      Number(user.id),
      user.email,
      user.name,
      roles,
      user.mfa_enabled,
      userAgent,
      ipAddress,
    );
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    const stored = await this.repo.findValidRefreshToken(tokenHash);
    if (stored) {
      await this.repo.revokeRefreshToken(stored.id);
    }
  }

  async logoutAll(userId: number): Promise<void> {
    await this.repo.revokeAllUserRefreshTokens(BigInt(userId));
  }

  async getSessions(userId: number) {
    const sessions = await this.repo.findActiveSessionsByUserId(BigInt(userId));
    return sessions.map((s) => ({
      id: Number(s.id),
      created_at: s.created_at,
      expires_at: s.expires_at,
      user_agent: s.user_agent,
      ip_address: s.ip_address,
    }));
  }

  async revokeSession(userId: number, sessionId: number): Promise<void> {
    const revoked = await this.repo.revokeSessionById(
      BigInt(sessionId),
      BigInt(userId),
    );
    if (!revoked) throw new NotFoundException(`Session ${sessionId} not found`);
  }

  async changePassword(
    userId: number,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    if (currentPassword === newPassword) {
      throw new BadRequestException(
        "New password must differ from current password",
      );
    }
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundException("User not found");

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) {
      throw new UnauthorizedException("Current password is incorrect");
    }

    const newHash = await bcrypt.hash(newPassword, 12);
    await this.repo.updatePassword(BigInt(userId), newHash);
    // Revoke all sessions so other devices must re-authenticate
    await this.repo.revokeAllUserRefreshTokens(BigInt(userId));
  }

  /* ── MFA ───────────────────────────────────────────────────────────── */

  async generateMfaSetup(
    userId: number,
  ): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundException("User not found");
    if (user.mfa_enabled) {
      throw new BadRequestException(
        "MFA is already enabled. Verify your current code to disable it before setting up a new authenticator.",
      );
    }

    const secret = this.generateBase32Secret();
    const encryptedSecret = this.encryption.encrypt(secret);
    await this.repo.updateMfa(BigInt(userId), false, encryptedSecret);

    const otpauthUrl = `otpauth://totp/Bedrock%20Forge:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Bedrock%20Forge`;
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return { secret, qrCodeDataUrl };
  }

  async enableMfa(userId: number, code: string): Promise<void> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundException("User not found");
    if (!user.totp_secret_encrypted) {
      throw new BadRequestException(
        "MFA not set up yet. Generate setup first.",
      );
    }

    const secret = this.encryption.decrypt(user.totp_secret_encrypted);
    const matchedStep = this.verifyTOTP(secret, code);
    if (matchedStep === null) {
      throw new BadRequestException("Invalid MFA verification code");
    }

    await this.repo.updateMfa(BigInt(userId), true, user.totp_secret_encrypted);
    await this.repo.updateLastTotpStep(BigInt(userId), BigInt(matchedStep));
  }

  async disableMfa(userId: number, code: string): Promise<void> {
    const user = await this.repo.findUserById(userId);
    if (!user) throw new NotFoundException("User not found");
    if (!user.mfa_enabled) {
      throw new BadRequestException("MFA is not currently enabled");
    }
    if (!user.totp_secret_encrypted) {
      throw new BadRequestException("MFA configuration error: no secret found");
    }
    const secret = this.encryption.decrypt(user.totp_secret_encrypted);
    const matchedStep = this.verifyTOTP(secret, code);
    if (matchedStep === null) {
      throw new UnauthorizedException(
        "Invalid MFA code — please provide your current authenticator code to disable MFA",
      );
    }
    // Prevent replay of the same TOTP window used to disable MFA
    if (
      user.last_totp_step !== null &&
      BigInt(matchedStep) <= user.last_totp_step
    ) {
      throw new UnauthorizedException("MFA code has already been used");
    }
    await this.repo.updateMfa(BigInt(userId), false, null);
    // Revoke all sessions so other devices must re-authenticate without MFA
    await this.repo.revokeAllUserRefreshTokens(BigInt(userId));
  }

  refreshExpiresMs(): number {
    const raw = this.config.get<string>("jwt.refreshExpiresIn") ?? "30d";
    // Parse simple duration strings: Nd, Nh, Nm, Ns
    const match = /^(\d+)([dhms])$/.exec(raw);
    if (!match) return 30 * 24 * 60 * 60 * 1_000;
    const n = parseInt(match[1], 10);
    const multipliers: Record<string, number> = {
      d: 24 * 60 * 60 * 1_000,
      h: 60 * 60 * 1_000,
      m: 60 * 1_000,
      s: 1_000,
    };
    return n * multipliers[match[2]];
  }

  private async issueTokens(
    userId: number,
    email: string,
    name: string,
    roles: string[],
    mfaEnabled: boolean,
    userAgent?: string,
    ipAddress?: string,
  ): Promise<TokenPair> {
    const payload = { sub: userId, email, roles };

    const accessToken = this.jwtService.sign(payload, {
      secret: this.config.get<string>("jwt.secret"),
      expiresIn: (this.config.get<string>("jwt.accessExpiresIn") ?? "15m") as
        | `${number}${"s" | "m" | "h" | "d"}`
        | number,
    });

    const rawRefreshToken = crypto.randomBytes(64).toString("hex");
    const refreshTokenHash = this.hashToken(rawRefreshToken);

    const expiresAt = new Date(Date.now() + this.refreshExpiresMs());

    await this.repo.storeRefreshToken(
      BigInt(userId),
      refreshTokenHash,
      expiresAt,
      userAgent,
      ipAddress,
    );

    return {
      accessToken,
      refreshToken: rawRefreshToken,
      user: { id: userId, email, name, roles, mfa_enabled: mfaEnabled },
    };
  }

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  private base32Decode(str: string): Buffer {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const cleanStr = str.replace(/=+$/, "").toUpperCase();
    let bits = 0;
    let val = 0;
    const bytes: number[] = [];

    for (let i = 0; i < cleanStr.length; i++) {
      const idx = alphabet.indexOf(cleanStr[i]);
      if (idx === -1) {
        throw new Error("Invalid base32 character");
      }
      val = (val << 5) | idx;
      bits += 5;
      if (bits >= 8) {
        bytes.push((val >> (bits - 8)) & 255);
        bits -= 8;
      }
    }
    return Buffer.from(bytes);
  }

  private generateTOTP(secretBase32: string, timeStepIndex: number): string {
    const key = this.base32Decode(secretBase32);
    const buffer = Buffer.alloc(8);
    const high = Math.floor(timeStepIndex / 0x100000000);
    const low = timeStepIndex % 0x100000000;
    buffer.writeUInt32BE(high, 0);
    buffer.writeUInt32BE(low, 4);

    const hmac = crypto.createHmac("sha1", key).update(buffer).digest();

    const offset = hmac[hmac.length - 1] & 0xf;
    const code =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = code % 1000000;
    return otp.toString().padStart(6, "0");
  }

  private verifyTOTP(secretBase32: string, token: string): number | null {
    if (!/^\d{6}$/.test(token)) return null;
    const now = Math.floor(Date.now() / 1000 / 30);
    for (let i = -1; i <= 1; i++) {
      const step = now + i;
      if (this.generateTOTP(secretBase32, step) === token) {
        return step;
      }
    }
    return null;
  }

  private generateBase32Secret(length = 16): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let secret = "";
    const bytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
      secret += alphabet[bytes[i] % 32];
    }
    return secret;
  }
}
