import { Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { envSchema } from './env.schema';

@Module({
  imports: [
    NestConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: (raw) => {
        const result = envSchema.safeParse(raw);
        if (!result.success) {
          throw new Error(
            `Invalid environment: ${JSON.stringify(result.error.flatten().fieldErrors)}`,
          );
        }
        return result.data;
      },
    }),
  ],
})
export class ConfigModule {}
