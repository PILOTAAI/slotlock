// Deployment, once per release, as the role that owns the `slotlock` schema and everything in it:
// never the role that serves traffic. `applySchema` needs CREATE on the database for the `slotlock`
// schema, and creates btree_gist in it when missing. Whoever owns btree_gist, or the schema it lives
// in, can drop the overlap arbiter: if it is created beforehand, a superuser should create it.
// #region deploy
import { createSlotlockStore } from 'slotlock';
import postgres from 'postgres';

export async function deploySlotlock(deployUrl: string, applicationRole: string): Promise<void> {
  const sql = postgres(deployUrl, { max: 1, onnotice: () => {} });
  try {
    const store = createSlotlockStore(sql);
    await store.applySchema();
    await store.applyTenantRls();
    await store.grantApplicationRole(applicationRole);
  } finally {
    await sql.end();
  }
}
// #endregion deploy
