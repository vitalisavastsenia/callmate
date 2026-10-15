import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { ContactDetailsSchema, ContactSchema, IdSchema, api, type ContactDetails } from "@callmate/contracts";
import type { FastifyInstance } from "fastify";
import { CommandError } from "./errors.js";
import type { Store } from "./storage.js";

type Row = { id: string; name: string; phone: string; time_zone: string; tone: string; notes: string };
const read = (row: Row) => ContactSchema.parse({ id: row.id, name: row.name, phone: row.phone,
  timeZone: row.time_zone, tone: JSON.parse(row.tone), notes: row.notes });

export function contactStore(db: Database.Database) {
  const find = (id: string) => db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
  const save = (input: ContactDetails, id?: string) => {
    const value = ContactDetailsSchema.parse(input);
    if (id && !find(id)) throw new CommandError(404, "NOT_FOUND", "Contact not found; save as a new contact");
    const contactId = id ?? randomUUID(); const now = new Date().toISOString();
    try {
      if (id) db.prepare("UPDATE contacts SET name = ?, phone = ?, time_zone = ?, tone = ?, notes = ?, updated_at = ? WHERE id = ?")
        .run(value.name, value.phone, value.timeZone, JSON.stringify(value.tone), value.notes, now, id);
      else db.prepare("INSERT INTO contacts (id, name, phone, time_zone, tone, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(contactId, value.name, value.phone, value.timeZone, JSON.stringify(value.tone), value.notes, now, now);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new CommandError(409, "CONTACT_ALREADY_EXISTS", "A contact with this phone number already exists");
      }
      throw error;
    }
    return read(find(contactId)!);
  };
  return {
    list: () => (db.prepare("SELECT * FROM contacts ORDER BY name COLLATE NOCASE, id").all() as Row[]).map(read),
    save,
    remove(id: string) { db.prepare("DELETE FROM contacts WHERE id = ?").run(id); },
    import(contacts: ContactDetails[]): { imported: number; duplicates: number } {
      return db.transaction((contacts: ContactDetails[]) => {
      let imported = 0; let duplicates = 0;
      for (const value of contacts) {
        try { save(value); imported++; }
        catch (error) {
          if (error instanceof CommandError && error.code === "CONTACT_ALREADY_EXISTS") duplicates++;
          else throw error;
        }
      }
      return { imported, duplicates };
      })(contacts);
    },
  };
}

export function contactRoutes(app: FastifyInstance, store: Store) {
  const id = (params: unknown) => IdSchema.parse((params as { contactId: string }).contactId);
  app.get(api.listContacts.path, async () => api.listContacts.response.parse({ items: store.contacts.list() }));
  app.post(api.createContact.path, async (request, reply) => reply.code(201).send(api.createContact.response.parse({
    contact: store.contacts.save(api.createContact.request.parse(request.body)),
  })));
  app.put(api.updateContact.path, async request => api.updateContact.response.parse({
    contact: store.contacts.save(api.updateContact.request.parse(request.body), id(request.params)),
  }));
  app.delete(api.deleteContact.path, async request => {
    const contactId = id(request.params); store.contacts.remove(contactId);
    return api.deleteContact.response.parse({ contactId, deleted: true });
  });
  app.post(api.importContacts.path, async request => api.importContacts.response.parse(
    store.contacts.import(api.importContacts.request.parse(request.body).contacts)));
}
