import 'reflect-metadata';
import { Inject, Injectable } from '@nestjs/common';
import { sql, type DatabaseConnection } from '@paint/db';
import { DATABASE } from '../database/database.module.js';

@Injectable()
export class HealthService {
  constructor(@Inject(DATABASE) private readonly connection: DatabaseConnection) {}

  /** True when PostgreSQL answers a trivial query. */
  async isDatabaseUp(): Promise<boolean> {
    try {
      await this.connection.db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  }
}
