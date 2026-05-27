import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { Env } from '../config/env.schema';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const provided = req.header('x-api-key');
    if (!provided) {
      throw new UnauthorizedException('Missing X-API-Key header');
    }

    const allowed = this.config.get('TRENDS_API_KEYS', { infer: true });
    if (!allowed.includes(provided)) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
