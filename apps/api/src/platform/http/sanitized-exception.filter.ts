import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";

@Catch()
export class SanitizedExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const status = exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = exception instanceof HttpException ? exception.getResponse() : undefined;
    const message = typeof exceptionResponse === "object" && exceptionResponse !== null && "message" in exceptionResponse
      ? (exceptionResponse as { message: string | string[] }).message
      : status === HttpStatus.INTERNAL_SERVER_ERROR ? "Internal server error" : "Request failed";

    response.status(status).json({
      statusCode: status,
      message,
      error: status === HttpStatus.INTERNAL_SERVER_ERROR ? "Internal Server Error" : undefined
    });
  }
}
