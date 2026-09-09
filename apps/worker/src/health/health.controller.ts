import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseService } from "@vendorflow/database";
import { RabbitMqService } from "../messaging/rabbitmq.service";

/**
 * REL-008, for a process that serves no business traffic.
 *
 * Liveness answers "is this process running", and nothing else. It must not consult a
 * dependency: a worker that restarts every time RabbitMQ blinks is a worse outage than the
 * blink, and the outbox it drains is perfectly safe in PostgreSQL meanwhile.
 *
 * Readiness answers "can this process do its job", which needs both halves: PostgreSQL to
 * claim and to record, and a usable RabbitMQ channel to publish and consume. Unready here
 * means "not draining", not "kill me".
 *
 * The API's readiness deliberately does not gain a RabbitMQ check. Purchase decisions must
 * keep committing while the side-effect path is degraded (REL-007).
 */
@Controller("health")
export class HealthController {
  constructor(
    private readonly database: DatabaseService,
    private readonly rabbitMq: RabbitMqService
  ) {}

  @Get()
  liveness(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async readiness(): Promise<{ status: "ok" }> {
    const [databaseReady, brokerReady] = [await this.database.isHealthy(), this.rabbitMq.isUsable()];

    if (!databaseReady || !brokerReady) {
      // Which dependency is down is operational detail about this process, not about a
      // tenant, so naming it here helps an operator without disclosing anything.
      throw new ServiceUnavailableException(
        databaseReady ? "RabbitMQ is unavailable" : "Database is unavailable"
      );
    }

    return { status: "ok" };
  }
}
