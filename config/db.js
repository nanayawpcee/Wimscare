const mongoose = require('mongoose');

// Cached across warm serverless invocations (module scope survives between
// calls on the same Vercel function instance) so each request doesn't open
// its own MongoDB connection.
let connectPromise = null;

async function connectDB() {
  mongoose.set('strictQuery', true);
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (!connectPromise) {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/wimscare';
    connectPromise = mongoose.connect(uri).then((m) => {
      console.log(`[db] connected to ${mongoose.connection.name}`);
      return m.connection;
    }).catch((err) => {
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}

module.exports = { connectDB };
