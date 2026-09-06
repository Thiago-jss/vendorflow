import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { Environment } from "./config/env";
import { configureHttpApplication } from "./platform/http/http-configuration";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  const config = app.get(ConfigService<Environment, true>);

  app.useLogger(logger);
  app.enableShutdownHooks();
  // Deliberately no app.set("trust proxy"): no proxy topology is configured, and trusting
  // forwarding headers would let a client choose the source address the rate limiter sees.
  configureHttpApplication(app, {
    CORS_ORIGINS: config.get("CORS_ORIGINS", { infer: true }),
  });

  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  logger.log(`API listening on port ${port}`, "Bootstrap");
}

void bootstrap();
