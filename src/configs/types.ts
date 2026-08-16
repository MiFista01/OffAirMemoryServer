import { Request } from 'express';
import { UserProfile } from 'src/resources/user/profile/entities/profile.entity';
import { UserAuth } from 'src/resources/user/auth/entities/auth.entity';

export type ReqWithUser = Request & {
  user: {
    userId: number;
    uuid: string;
    exp: number;
  };
  profile?: UserProfile;
  auth?: UserAuth;
  getProfile: () => Promise<UserProfile>;
  getAuth: () => Promise<UserAuth>;
};

export interface FileCleanerOptions {
  folder: string;
  fieldName: string;
  cleanUp: boolean;
}
