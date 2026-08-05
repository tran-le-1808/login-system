import * as mongoose from 'mongoose';

import * as dotenv from 'dotenv';

import { seedUsers } from './users.seed';

import { User, UserSchema } from '../users/entities/user.entity';

dotenv.config();

async function runSeeds() {
  //
  // CONNECT DATABASE
  //
  await mongoose.connect(process.env.MONGODB_URI as string);

  console.log('✅ MongoDB connected');

  //
  // MODELS
  //
  const UserModel = mongoose.model(User.name, UserSchema);

  //
  // RUN SEEDS
  //
  await seedUsers(UserModel);

  console.log('🎉 All seeds completed');

  process.exit();
}

runSeeds();
