import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { resolve } from "node:path";
import { validateEnvironment } from "./env";

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: [resolve(process.cwd(), "../../.env"), resolve(process.cwd(), ".env")],
      validate: validateEnvironment
    })
  ]
})
export class ApplicationConfigModule {}
