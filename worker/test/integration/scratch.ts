require('dotenv').config({path: '../../.dev.vars'});
const { neon } = require('@neondatabase/serverless');
const sql = neon(process.env.DATABASE_URL);
sql`SELECT ${sql.unsafe('1 as num')}`.then(console.log).catch(console.error);
