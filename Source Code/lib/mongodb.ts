
import { MongoClient } from 'mongodb';

// Robust environment variable retrieval
const getEnv = (key: string) => {
  try {
    return typeof process !== 'undefined' ? process.env[key] : null;
  } catch {
    return null;
  }
};

const uri = getEnv('MONGODB_URI') || 'mongodb+srv://wealthflow_admin:wealthflow001@wealthflow-cluster.e25dw6i.mongodb.net/?retryWrites=true&w=majority&appName=wealthflow-cluster';
const options = {};

let client: MongoClient;
let clientPromise: Promise<MongoClient>;

if (!uri) {
  throw new Error('Please add your Mongo URI to .env.local');
}

const isDev = getEnv('NODE_ENV') === 'development';

if (isDev) {
  // In development mode, use a global variable so that the value
  // is preserved across module reloads caused by HMR (Hot Module Replacement).
  let globalWithMongo = globalThis as typeof globalThis & {
    _mongoClientPromise?: Promise<MongoClient>;
  };

  if (!globalWithMongo._mongoClientPromise) {
    client = new MongoClient(uri, options);
    globalWithMongo._mongoClientPromise = client.connect();
  }
  clientPromise = globalWithMongo._mongoClientPromise;
} else {
  // In production mode, it's best to not use a global variable.
  client = new MongoClient(uri, options);
  clientPromise = client.connect();
}

// Export a module-scoped MongoClient promise. By doing this in a
// separate module, the client can be shared across functions.
export default clientPromise;
