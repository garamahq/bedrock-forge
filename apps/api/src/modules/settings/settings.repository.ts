import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class SettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.appSetting.findMany({ orderBy: { key: "asc" } });
  }

  findByKey(key: string) {
    return this.prisma.appSetting.findUnique({ where: { key } });
  }

  upsert(key: string, value: string) {
    return this.prisma.appSetting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  updateIfValueMatches(key: string, previousValue: string, nextValue: string) {
    return this.prisma.appSetting.updateMany({
      where: { key, value: previousValue },
      data: { value: nextValue, updated_at: new Date() },
    });
  }

  delete(key: string) {
    return this.prisma.appSetting.delete({ where: { key } });
  }
}
