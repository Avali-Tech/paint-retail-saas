import { ConsoleLogger } from '@nestjs/common';
import { LOG_LEVELS, type AppConfig, type LogLevel } from './config.js';

/** The chosen level and every more severe level, e.g. "warn" -> fatal, error, warn. */
export function enabledLogLevels(level: LogLevel): LogLevel[] {
  return LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1);
}

/**
 * JSON logs in production (one object per line, easy to search in CloudWatch),
 * readable coloured logs everywhere else.
 */
export function createLogger(config: Pick<AppConfig, 'nodeEnv' | 'logLevel'>): ConsoleLogger {
  const production = config.nodeEnv === 'production';
  return new ConsoleLogger({
    json: production,
    colors: !production,
    logLevels: enabledLogLevels(config.logLevel),
  });
}
