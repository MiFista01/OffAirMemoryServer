import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { v7 as uuidv7 } from 'uuid';
import { TokenBlacklist } from './entities/tokenBlacklist.entity.lite';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { every3Days } from '@cron';
import { cookiesDays, dayMs } from '@constants';
import { Logger } from 'winston';
import { WINSTON_MODULE_PROVIDER } from 'nest-winston';

@Injectable()
export class TooledJwtService {
  constructor(
    @InjectRepository(TokenBlacklist, 'lite')
    private readonly tokenBlacklistRep: Repository<TokenBlacklist>,
    private readonly jwt: JwtService,
    @Inject(WINSTON_MODULE_PROVIDER)
    protected readonly logger: Logger,
  ) {}

  createToken(payload: any) {
    const newPayload = structuredClone(payload);
    newPayload.uuid = uuidv7();
    return this.jwt.sign(newPayload);
  }
  updateToken(oldPayload: any, newPayload: any, expiresIn?: number) {
    const { exp, iat, nbf, ...rest } = oldPayload;
    const payload = {
      ...rest,
      ...newPayload,
    };
    return this.jwt.sign(payload, {
      expiresIn: expiresIn ? `${expiresIn}s` : '2d',
    });
  }
  async addToBlacklist(uuid: string) {
    return this.tokenBlacklistRep.save({
      uuid: uuid,
      createdAt: new Date(),
    });
  }

  async isBlacklist(uuid: string) {
    const tokenBlacklist = await this.tokenBlacklistRep.findOneBy({
      uuid: uuid,
    });
    if (tokenBlacklist) {
      await this.tokenBlacklistRep.increment({ uuid: uuid }, 'countUsage', 1);
    }
    return !!tokenBlacklist;
  }

  @Cron(every3Days)
  async clearFromBlacklist() {
    const currentDate = new Date();
    const clearDate = new Date(currentDate.getTime() - dayMs * cookiesDays);
    const result = await this.tokenBlacklistRep.delete({
      createdAt: LessThan(clearDate),
    });
    this.logger.info('clearFromBlacklist: Removed entries from blacklist', {
      tag: 'Cron',
      msg: `Removed ${result.affected ?? 0} entries from blacklist`,
    });
  }
}
