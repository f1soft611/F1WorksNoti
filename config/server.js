import sql from 'mssql';
import { config } from './config.js';

const connPool = new sql.ConnectionPool(config.dbconfig)
  .connect()
  .then((pool) => {
    console.log('DB연결 성공');
    return pool;
  })
  .catch((err) => {
    console.log('err ', err);
  });

export {
  sql,
  connPool
}