import { Module } from "@nestjs/common";
import { JwtModule, type JwtSignOptions } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthRepository } from "./auth.repository";
import { JwtStrategy } from "./jwt.strategy";
import { EncryptionModule } from "../../common/encryption/encryption.module";

@Module({
  imports: [
    PassportModule.register({ defaultStrategy: "jwt" }),
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("jwt.secret"),
        signOptions: {
          expiresIn: config.get<JwtSignOptions["expiresIn"]>(
            "jwt.accessExpiresIn",
          ),
        },
      }),
    }),
    EncryptionModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, AuthRepository, JwtStrategy],
  exports: [JwtModule, PassportModule],
})
export class AuthModule {}
