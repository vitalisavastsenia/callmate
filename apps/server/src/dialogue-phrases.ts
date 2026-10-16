import type Database from "better-sqlite3";
import { dialoguePhraseCatalog, defaultPhraseLookup, type PhraseLookup } from "@callmate/dialogue";

/** Versioned application-owned text, not a user-editable prompt/authorization store. */
export function dialoguePhraseStore(db: Database.Database) {
  const insert = db.prepare("INSERT OR IGNORE INTO dialogue_phrases (phrase_id, version, language, template) VALUES (?, ?, ?, ?)");
  const select = db.prepare("SELECT template FROM dialogue_phrases WHERE phrase_id = ? AND version = ? AND language = ?");
  const lookup: PhraseLookup = (id, version, language) => {
    const row = select.get(id, version, language) as { template: string } | undefined;
    // An edited DB row cannot silently change a controlled policy reply under the same version.
    if (!row || row.template !== defaultPhraseLookup(id, version, language)) throw new Error("Missing or incompatible dialogue phrase");
    return row.template;
  };
  const check = () => { for (const row of dialoguePhraseCatalog) lookup(row.id, row.version, row.language); };
  db.transaction(() => {
    for (const row of dialoguePhraseCatalog) insert.run(row.id, row.version, row.language, row.template);
    check();
  }).immediate();
  return { lookup, check };
}
