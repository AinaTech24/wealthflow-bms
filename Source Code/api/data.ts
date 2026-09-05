
import clientPromise from '../lib/mongodb';

const VALID_COLLECTIONS = [
  'clients', 'team', 'transactions', 'batches', 
  'amc_mappings', 'scheme_mappings', 'config', 'invoices'
];

export default async function handler(req: any, res: any) {
  let client;
  try {
    client = await clientPromise;
  } catch (err) {
    console.error("Failed to connect to MongoDB Cluster:", err);
    return res.status(503).json({ error: 'Database Connection Failed' });
  }

  const db = client.db('wealthflow');
  const { method, body, query } = req;

  try {
    switch (method) {
      case 'GET': {
        const type = query.type;
        if (!type || !VALID_COLLECTIONS.includes(type)) {
          return res.status(400).json({ error: 'Invalid or missing collection type' });
        }
        
        // Fetch data
        const data = await db.collection(type).find({}).toArray();
        return res.status(200).json(data || []);
      }

      case 'POST': {
        // Handle Authentication Request
        if (body.action === 'auth') {
          const { identifier, password } = body;
          if (!identifier || !password) {
            return res.status(400).json({ error: 'Missing credentials' });
          }

          const user = await db.collection('team').findOne({
            $or: [
              { email: identifier },
              { code: identifier }
            ],
            password: password
          });

          if (user) {
            // Return user without sensitive data if needed, or full object for context
            return res.status(200).json({ success: true, user });
          } else {
            return res.status(401).json({ error: 'Invalid credentials' });
          }
        }

        // Handle Data Updates
        const { collection, payload, upsertField } = body;
        if (!collection || !VALID_COLLECTIONS.includes(collection) || !payload) {
          return res.status(400).json({ error: 'Invalid collection or missing payload' });
        }

        const now = new Date().toISOString();
        const filterKey = upsertField || 'id';

        if (Array.isArray(payload)) {
          if (payload.length === 0) return res.status(200).json({ success: true, count: 0 });
          
          const operations = payload.map(item => ({
            updateOne: {
              filter: { [filterKey]: item[filterKey] },
              update: { 
                $set: { ...item, updatedAt: now },
                $setOnInsert: { createdAt: now }
              },
              upsert: true
            }
          }));
          const result = await db.collection(collection).bulkWrite(operations);
          return res.status(200).json({ success: true, count: result.upsertedCount + result.modifiedCount });
        } else {
          // Handle single object update
          const filterValue = payload[filterKey] || payload.id || payload._id;
          if (!filterValue) return res.status(400).json({ error: 'Payload missing identifying key (id)' });

          await db.collection(collection).updateOne(
            { [filterKey]: filterValue },
            { 
              $set: { ...payload, updatedAt: now },
              $setOnInsert: { createdAt: now }
            },
            { upsert: true }
          );
          return res.status(200).json({ success: true, timestamp: now });
        }
      }

      case 'DELETE': {
        if (query.action === 'reset') {
          for (const col of VALID_COLLECTIONS) {
            await db.collection(col).deleteMany({});
          }
          return res.status(200).json({ success: true });
        }
        
        const type = query.type;
        const id = query.id;
        if (type && id && VALID_COLLECTIONS.includes(type)) {
          await db.collection(type).deleteOne({ id: id });
          return res.status(200).json({ success: true });
        }

        return res.status(400).json({ error: 'Invalid action or missing parameters' });
      }

      default:
        res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
        return res.status(405).end(`Method ${method} Not Allowed`);
    }
  } catch (e: any) {
    console.error('MongoDB Operation Error:', e);
    return res.status(500).json({ error: e.message || 'Internal Server Error' });
  }
}
