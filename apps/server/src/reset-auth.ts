import { loadConfig } from "./config.js";
import { openStore } from "./storage.js";

const store = openStore(loadConfig(process.env).dataDir);
try {
  store.auth.resetOwner();
  process.stdout.write("Owner account and sessions removed. Open CallMate to set up a new owner. Application data is preserved.\n");
} finally { store.close(); }
