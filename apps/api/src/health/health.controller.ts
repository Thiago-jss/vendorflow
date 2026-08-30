import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";

@Controller("health")
export class HealthController {
  constructor(private readonly database: DatabaseService) {}

  @Get()
  liveness(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(): Promise<{ status: "ok" }> {
    if (!(await this.database.isHealthy())) {
      throw new ServiceUnavailableException("Database is unavailable");
    }

    return { status: "ok" };
  }
}
