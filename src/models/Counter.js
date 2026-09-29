import mongoose from 'mongoose';
const S = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
export default mongoose.models.Counter || mongoose.model('Counter', S);
