import { Request } from 'express';

import { JwtPayload } from 'src/auth/interfaces/jwt-payload.interface';

export interface RequestWithUser extends Request {
  user: JwtPayload;
}
