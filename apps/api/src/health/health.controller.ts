import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { PrismaService } from "../platform/prisma/prisma.service";

@Controller("health")
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  liveness(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(): Promise<{ status: "ok" }> {
    if (!(await this.prisma.isHealthy())) {
      throw new ServiceUnavailableException("Database is unavailable");
    }

    return { status: "ok" };
  }
}
