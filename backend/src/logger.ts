import { redactForLog } from "./utils";

export interface LogContext {
  requestId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export class Logger {
  constructor(private readonly serviceName: string) {}

  info(message: string, context: LogContext = {}): void {
    this.log("INFO", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.log("WARN", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.log("ERROR", message, context);
  }

  private log(level: "INFO" | "WARN" | "ERROR", message: string, context: LogContext): void {
    const entry = {
      timestamp: new Date().toISOString(),
      service: this.serviceName,
      level,
      message,
      context: redactForLog(context),
    };
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(entry));
  }
}

export const logger = new Logger("silvervisit-backend");
