import { Model } from 'mongoose';

import * as bcrypt from 'bcrypt';

export async function seedUsers(User: Model<any>) {
  const password = await bcrypt.hash('123456', 10);

  const users = [
    {
      name: 'Brooklyn Simmons',

      email: 'brooklyn@gmail.com',

      avatar: 'https://i.pravatar.cc/300?img=1',
    },

    {
      name: 'Jenny Wilson',

      email: 'jenny@gmail.com',

      avatar: 'https://i.pravatar.cc/300?img=2',
    },
  ];

  for (const user of users) {
    await User.findOneAndUpdate(
      {
        email: user.email,
      },

      {
        $set: {
          name: user.name,

          avatar: user.avatar,

          password,
        },
      },

      {
        upsert: true,

        new: true,
      },
    );
  }

  console.log('✅ Users seeded');
}
