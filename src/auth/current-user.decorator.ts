import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { JwtPayload } from './jwt-payload';

/** Injects the verified JWT payload of the requesting user. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): JwtPayload => {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user: JwtPayload }>();
    return req.user;
  },
);
