import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT,
  dbconfig: {
    server: process.env.DB_DEV_SERVER,
    port: parseInt(process.env.DB_DEV_PORT),
    pool: {
      max: 100,
      min: 20,
      idleTimeoutMillis: 30000,
    },
    options: {
      encrypt: false,
      db: process.env.DB_DEV_DATEBASE,
      trustServerCertificate: true,
    },
    authentication: {
      type: 'default',
      options: {
        userName: process.env.DB_DEV_USERNAME,
        password: process.env.DB_DEV_PASSOWRD,
      },
    },
  },
};