export { DatabaseModule } from "./database.module";
export { DatabaseService } from "./database.service";
// Re-exported so business modules can type transaction clients and error codes without
// importing @prisma/client directly, which ADR-002 restricts to this package.
export { Prisma } from "@prisma/client";
