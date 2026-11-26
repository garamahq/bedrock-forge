import { Test } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { UnauthorizedException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { AuthService } from "./auth.service";
import { AuthRepository } from "./auth.repository";
import { EncryptionService } from "../../common/encryption/encryption.service";

const mockUser = {
  id: BigInt(1),
  email: "test@forge.local",
  name: "Test User",
  password_hash: "$2a$12$placeholder",
  user_roles: [{ role: { name: "admin" } }],
  mfa_enabled: false,
  login_failures: 0,
  locked_until: null,
};

const makeRepo = () => ({
  findUserByEmail: jest.fn(),
  findUserById: jest.fn(),
  createUser: jest.fn(),
  storeRefreshToken: jest.fn(),
  findValidRefreshToken: jest.fn(),
  revokeRefreshToken: jest.fn(),
  rotateRefreshToken: jest.fn(),
  revokeAllUserRefreshTokens: jest.fn(),
  updatePassword: jest.fn(),
  updateMfa: jest.fn(),
  updateLastTotpStep: jest.fn(),
  recordLoginFailure: jest.fn(),
  resetLoginFailures: jest.fn(),
});

const makeJwt = () => ({
  sign: jest.fn().mockReturnValue("signed-access-token"),
});

const makeConfig = () => ({
  get: jest.fn().mockImplementation((key: string) => {
    if (key === "jwt.secret") return "test-secret";
    if (key === "jwt.accessExpiresIn") return "4h";
    if (key === "jwt.refreshExpiresIn") return "30d";
    return undefined;
  }),
});

describe("AuthService", () => {
  let service: AuthService;
  let repo: ReturnType<typeof makeRepo>;
  let jwt: ReturnType<typeof makeJwt>;

  beforeEach(async () => {
    repo = makeRepo();
    jwt = makeJwt();
    const module = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: repo },
        { provide: JwtService, useValue: jwt },
        { provide: ConfigService, useValue: makeConfig() },
        { provide: EncryptionService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
      ],
    }).compile();

    service = module.get(AuthService);
  });

  describe("login", () => {
    it("throws UnauthorizedException for unknown email", async () => {
      repo.findUserByEmail.mockResolvedValue(null);
      await expect(service.login("nobody@x.com", "pass")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("throws UnauthorizedException for wrong password", async () => {
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: await bcrypt.hash("correct", 12),
      });
      await expect(service.login("test@forge.local", "wrong")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns token pair on valid credentials", async () => {
      const hash = await bcrypt.hash("secret", 12);
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: hash,
      });
      repo.storeRefreshToken.mockResolvedValue(undefined);

      const result = (await service.login("test@forge.local", "secret")) as any;
      expect(result.accessToken).toBe("signed-access-token");
      expect(result.refreshToken).toBeDefined();
      expect(result.user.email).toBe("test@forge.local");
      expect(jwt.sign).toHaveBeenCalledWith(
        expect.objectContaining({ sub: 1 }),
        expect.objectContaining({ expiresIn: "4h" }),
      );
      expect(repo.storeRefreshToken).toHaveBeenCalledWith(
        BigInt(1),
        expect.any(String),
        expect.any(Date),
        undefined,
        undefined,
      );
      const expiresAt = repo.storeRefreshToken.mock.calls[0][2] as Date;
      const daysUntilExpiry =
        (expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysUntilExpiry).toBeGreaterThan(29.9);
      expect(daysUntilExpiry).toBeLessThanOrEqual(30);
    });
  });

  describe("refresh", () => {
    it("throws UnauthorizedException for invalid token", async () => {
      repo.rotateRefreshToken.mockResolvedValue(null);
      await expect(service.refresh("bad-token")).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("rotates token atomically on valid refresh", async () => {
      repo.rotateRefreshToken.mockResolvedValue(mockUser);

      const result = await service.refresh("valid-refresh-token");
      expect(repo.rotateRefreshToken).toHaveBeenCalledWith(
        expect.objectContaining({
          oldTokenHash: expect.any(String),
          newTokenHash: expect.any(String),
          expiresAt: expect.any(Date),
        }),
      );
      expect(result.accessToken).toBe("signed-access-token");
      expect(result.refreshToken).toBeTruthy();
    });
  });

  describe("logout", () => {
    it("revokes token if found", async () => {
      const storedToken = { id: BigInt(3), user_id: BigInt(1) };
      repo.findValidRefreshToken.mockResolvedValue(storedToken);
      repo.revokeRefreshToken.mockResolvedValue(undefined);

      await service.logout("some-token");
      expect(repo.revokeRefreshToken).toHaveBeenCalledWith(storedToken.id);
    });

    it("does nothing if token not found", async () => {
      repo.findValidRefreshToken.mockResolvedValue(null);
      await expect(service.logout("ghost-token")).resolves.toBeUndefined();
      expect(repo.revokeRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe("changePassword", () => {
    const userId = 1;

    it("throws BadRequestException when new password equals current", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      await expect(
        service.changePassword(userId, "samepass", "samepass"),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException if user does not exist", async () => {
      const { NotFoundException } = await import("@nestjs/common");
      repo.findUserById.mockResolvedValue(null);
      await expect(
        service.changePassword(userId, "oldpass", "newpass123"),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws UnauthorizedException for wrong current password", async () => {
      const hash = await bcrypt.hash("correctpass", 12);
      repo.findUserById.mockResolvedValue({ ...mockUser, password_hash: hash });
      await expect(
        service.changePassword(userId, "wrongpass", "newpass123"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("updates password and revokes all sessions on success", async () => {
      const hash = await bcrypt.hash("currentpass", 12);
      repo.findUserById.mockResolvedValue({ ...mockUser, password_hash: hash });
      repo.updatePassword.mockResolvedValue(undefined);
      repo.revokeAllUserRefreshTokens.mockResolvedValue(undefined);

      await service.changePassword(userId, "currentpass", "newpass123");

      expect(repo.updatePassword).toHaveBeenCalledWith(
        BigInt(userId),
        expect.any(String),
      );
      expect(repo.revokeAllUserRefreshTokens).toHaveBeenCalledWith(
        BigInt(userId),
      );
    });
  });

  describe("login with MFA", () => {
    let encryptionService: EncryptionService;
    beforeEach(() => {
      encryptionService = service['encryption'];
    });

    it("requires MFA code if mfa_enabled is true", async () => {
      const hash = await bcrypt.hash("secret", 12);
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: hash,
        mfa_enabled: true,
      });

      const result = await service.login("test@forge.local", "secret");
      expect(result).toEqual({ mfaRequired: true });
    });

    it("rejects invalid MFA code", async () => {
      const hash = await bcrypt.hash("secret", 12);
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: hash,
        mfa_enabled: true,
        totp_secret_encrypted: "encrypted-secret",
      });
      jest.spyOn(encryptionService, "decrypt").mockReturnValue("SECRET32");
      jest.spyOn(service as any, "verifyTOTP").mockReturnValue(null);

      await expect(
        service.login("test@forge.local", "secret", "123456"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects replayed/used MFA code", async () => {
      const hash = await bcrypt.hash("secret", 12);
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: hash,
        mfa_enabled: true,
        totp_secret_encrypted: "encrypted-secret",
        last_totp_step: BigInt(1000),
      });
      jest.spyOn(encryptionService, "decrypt").mockReturnValue("SECRET32");
      jest.spyOn(service as any, "verifyTOTP").mockReturnValue(1000); // matches last_totp_step

      await expect(
        service.login("test@forge.local", "secret", "123456"),
      ).rejects.toThrow("MFA code has already been used");
    });

    it("accepts valid and non-replayed MFA code and updates last_totp_step", async () => {
      const hash = await bcrypt.hash("secret", 12);
      repo.findUserByEmail.mockResolvedValue({
        ...mockUser,
        password_hash: hash,
        mfa_enabled: true,
        totp_secret_encrypted: "encrypted-secret",
        last_totp_step: BigInt(999),
      });
      repo.storeRefreshToken.mockResolvedValue(undefined);
      repo.updateLastTotpStep.mockResolvedValue(undefined);
      jest.spyOn(encryptionService, "decrypt").mockReturnValue("SECRET32");
      jest.spyOn(service as any, "verifyTOTP").mockReturnValue(1000); // 1000 > 999

      const result = (await service.login("test@forge.local", "secret", "123456")) as any;
      expect(result.accessToken).toBe("signed-access-token");
      expect(repo.updateLastTotpStep).toHaveBeenCalledWith(BigInt(1), BigInt(1000));
    });
  });

  describe("enableMfa", () => {
    let encryptionService: EncryptionService;
    beforeEach(() => {
      encryptionService = service['encryption'];
      repo.updateMfa.mockResolvedValue(undefined);
      repo.updateLastTotpStep.mockResolvedValue(undefined);
    });

    it("throws BadRequestException if MFA setup is not generated", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      repo.findUserById.mockResolvedValue({
        ...mockUser,
        totp_secret_encrypted: null,
      });

      await expect(service.enableMfa(1, "123456")).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException if verification code is invalid", async () => {
      const { BadRequestException } = await import("@nestjs/common");
      repo.findUserById.mockResolvedValue({
        ...mockUser,
        totp_secret_encrypted: "encrypted-secret",
      });
      jest.spyOn(encryptionService, "decrypt").mockReturnValue("SECRET32");
      jest.spyOn(service as any, "verifyTOTP").mockReturnValue(null);

      await expect(service.enableMfa(1, "123456")).rejects.toThrow(BadRequestException);
    });

    it("enables MFA and sets last_totp_step on valid verification code", async () => {
      repo.findUserById.mockResolvedValue({
        ...mockUser,
        totp_secret_encrypted: "encrypted-secret",
      });
      jest.spyOn(encryptionService, "decrypt").mockReturnValue("SECRET32");
      jest.spyOn(service as any, "verifyTOTP").mockReturnValue(1000);

      await service.enableMfa(1, "123456");

      expect(repo.updateMfa).toHaveBeenCalledWith(BigInt(1), true, "encrypted-secret");
      expect(repo.updateLastTotpStep).toHaveBeenCalledWith(BigInt(1), BigInt(1000));
    });
  });
});
