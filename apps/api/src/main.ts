import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { Logger } from "nestjs-pino";
import { AppModule } from "./app.module";
import type { Environment } from "./config/env";
import { SanitizedExceptionFilter } from "./platform/http/sanitized-exception.filter";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(Logger);
  const config = app.get(ConfigService<Environment, true>);

  app.useLogger(logger);
  app.enableShutdownHooks();
  app.use(helmet());
  app.enableCors({
    origin: config.get("CORS_ORIGINS", { infer: true }),
    credentials: true,
    methods: ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"]
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
  app.useGlobalFilters(new SanitizedExceptionFilter());

  const port = config.get("PORT", { infer: true });
  await app.listen(port);
  logger.log(`API listening on port ${port}`, "Bootstrap");
}

void bootstrap();
