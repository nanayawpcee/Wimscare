const mongoose = require('mongoose');

async function connectDB() {
  mongoose.set('strictQuery', true);
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/wimscare';
  await mongoose.connect(uri);
  console.log(`[db] connected to ${mongoose.connection.name}`);
}

module.exports = { connectDB };
