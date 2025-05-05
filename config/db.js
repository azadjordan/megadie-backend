import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";

const connectDB = async () => {
  try {
    console.log('Connecting to MongoDB...');
    const conn = await mongoose.connect(process.env.MONGO_URI);    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📦 Using Database: ${conn.connection.name}`);
  } catch (error) {    
    console.log(`❌ Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
