import { getDbPath } from "./db.js";
import { syncAll } from "./sync.js";

const stats = syncAll();
console.log(JSON.stringify({ dbPath: getDbPath(), ...stats }, null, 2));
