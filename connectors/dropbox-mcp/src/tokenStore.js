import { MongoClient } from "mongodb";
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://mongo:27017";
const TOKENS_COLLECTION = "dropbox_tokens";
const NONCES_COLLECTION = "dropbox_oauth_nonces";
let client = null;
const tenantDbs = new Map();
const initializedTenants = new Set();

async function connect() {
  if (client) return;
  client = new MongoClient(MONGODB_URI, { maxPoolSize: 10, minPoolSize: 1, serverSelectionTimeoutMS: 5000 });
  await client.connect();
}
async function ensureTenant(tenant) {
  if (!tenant) throw new Error("tenant required");
  if (initializedTenants.has(tenant)) return;
  if (!client) await connect();
  const db = client.db(`adas_${tenant}`);
  tenantDbs.set(tenant, db);
  await db.collection(TOKENS_COLLECTION).createIndex({ actor_id: 1 }, { unique: true });
  await db.collection(NONCES_COLLECTION).createIndex({ nonce: 1 }, { unique: true });
  await db.collection(NONCES_COLLECTION).createIndex({ created_at: 1 }, { expireAfterSeconds: 600 });
  initializedTenants.add(tenant);
}
function getTokensColl(tenant) { const db = tenantDbs.get(tenant); if (!db) throw new Error(`No DB for ${tenant}`); return db.collection(TOKENS_COLLECTION); }
function getNoncesColl(tenant) { const db = tenantDbs.get(tenant); if (!db) throw new Error(`No DB for ${tenant}`); return db.collection(NONCES_COLLECTION); }

export async function storeTokens(tenant, actorId, { accountEmail, accessToken, refreshToken, expiresAt, scope, accountId }) {
  await ensureTenant(tenant);
  await getTokensColl(tenant).updateOne({ actor_id: actorId }, { $set: { actor_id: actorId, account_email: accountEmail || null, account_id: accountId || null, access_token: accessToken, refresh_token: refreshToken, expires_at: expiresAt, scope: scope || null, updated_at: new Date() }, $setOnInsert: { created_at: new Date() } }, { upsert: true });
}
export async function updateAccessToken(tenant, actorId, { accessToken, expiresAt }) {
  await ensureTenant(tenant);
  await getTokensColl(tenant).updateOne({ actor_id: actorId }, { $set: { access_token: accessToken, expires_at: expiresAt, updated_at: new Date() } });
}
export async function getTokens(tenant, actorId) { await ensureTenant(tenant); return getTokensColl(tenant).findOne({ actor_id: actorId }); }
export async function deleteTokens(tenant, actorId) { await ensureTenant(tenant); await getTokensColl(tenant).deleteOne({ actor_id: actorId }); }
export async function storeNonce(tenant, nonce, actorId, codeVerifier) { await ensureTenant(tenant); await getNoncesColl(tenant).insertOne({ nonce, actor_id: actorId, tenant, code_verifier: codeVerifier, created_at: new Date() }); }
export async function consumeNonce(tenant, nonce) { await ensureTenant(tenant); return getNoncesColl(tenant).findOneAndDelete({ nonce }); }
