import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { Environment } from "./config/env";

async function bootstrap(): Promise<void> {
  // An HTTP application rather than a bare context: REL-008 asks for probes that distinguish
  // "process alive" from "dependencies usable", and an orchestrator needs somewhere to ask.
  // It serves health only; the worker takes no business traffic.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  const config = app.get(ConfigService<Environment, true>);

  app.useLogger(logger);
  app.enableShutdownHooks();

  const port = config.get("WORKER_PORT", { infer: true });
  await app.listen(port);
  logger.log(`Worker health endpoints listening on port ${port}`, "Bootstrap");
}

void bootstrap();
