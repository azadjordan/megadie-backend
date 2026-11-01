// Publishes reviewed browsing metadata only. Preview is read-only by default.
// Apply requires the exact state fingerprint printed by a successful preview.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

const [catalogId, ...flags] = process.argv.slice(2);
const apply = flags.includes('--apply');
const expectedSha = flags.find(flag => flag.startsWith('--expect-sha='))?.slice(13);
if (!mongoose.isObjectIdOrHexString(catalogId) || flags.some(flag => flag !== '--apply' && !/^--expect-sha=[a-f0-9]{64}$/.test(flag)) || (apply && !expectedSha)) {
  throw Error('Provide a catalog ID; optional --apply --expect-sha=<preview SHA256>');
}
const backend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
dotenv.config({path:path.join(backend,'.env'), quiet:true});
const output = path.join('/Users/azad/Backups/megadie', `shop-catalog-publish-${apply ? 'apply' : 'preview'}-${new Date().toISOString().replaceAll(':','-')}`);
await fs.mkdir(output,{recursive:true});
const report = {mode:apply ? 'apply' : 'preview', catalogId, output, committed:false};
const canonical = value => value instanceof Date ? value.toISOString()
  : value?.toHexString ? value.toHexString()
  : Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
const fingerprint = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const sorted = rows => rows.sort((a,b) => String(a._id).localeCompare(String(b._id)));
const normalize = value => String(value || '').normalize('NFKC').replace(/[\s_-]/g,'').toLowerCase();
const content = rows => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !['isActive','updatedAt'].includes(key))));
const writes = [];

await mongoose.connect(process.env.MONGO_URI,{autoCreate:false,autoIndex:false,monitorCommands:true,serverSelectionTimeoutMS:20000});
try {
  const db = mongoose.connection.db;
  if (db.databaseName !== 'production-db') throw Error('Unexpected database');
  mongoose.connection.getClient().on('commandStarted', event => {
    if (['update','insert','delete','findAndModify','create','createIndexes','drop','dropIndexes'].includes(event.commandName)) {
      writes.push({command:event.commandName, collection:event.command[event.commandName]});
    }
  });
  const inspect = async session => {
    const options = session ? {session} : {};
    const catalogs = sorted(await db.collection('catalogs').find({productType:'Ribbon'},options).toArray());
    if (catalogs.length !== 1 || String(catalogs[0]._id) !== catalogId) throw Error('Expected exactly the reviewed Ribbon catalog');
    const catalog = catalogs[0];
    if (catalog.name !== 'Ribbon colors' || catalog.layout !== 'color-grid') throw Error('Catalog metadata changed');
    const entries = sorted(await db.collection('catalogentries').find({catalog:catalog._id},options).toArray());
    if (entries.length !== 392) throw Error('Expected exactly 392 reviewed color entries');
    const categories = sorted(await db.collection('categories').find({productType:'Ribbon',key:{$in:['grosgrain','satin']}},options).toArray());
    if (categories.length !== 2 || categories.some(row => row.isActive !== true)) throw Error('Expected two active Ribbon materials');
    for (const material of ['grosgrain','satin']) {
      const matches = categories.filter(row => row.key === material);
      if (matches.length !== 1) throw Error('Missing/ambiguous material: '+material);
      const group = entries.filter(entry => String(entry.category) === String(matches[0]._id));
      if (group.length !== 196 || new Set(group.map(row => row.code)).size !== 196) throw Error('Expected 196 distinct colors: '+material);
      for (let page=1; page<=4; page++) {
        const positions = group.filter(row => row.page === page).map(row => row.position).sort((a,b) => a-b);
        if (positions.length !== 49 || positions.some((position,index) => position !== index+1)) throw Error('Unexpected catalog placement: '+material+' page '+page);
      }
    }
    const products = sorted(await db.collection('products').find({
      productType:'Ribbon', category:{$in:categories.map(row => row._id)},
      catalogCode:{$in:[...new Set(entries.map(row => row.code))]}, isActive:true, isAvailable:{$ne:false},
    },{...options,projection:{_id:1,category:1,catalogCode:1,color:1,images:1,isActive:1,isAvailable:1}}).toArray());
    for (const entry of entries) {
      const image = new URL(entry.imageUrl);
      if (typeof entry.code !== 'string' || !/^\d{3}$/.test(entry.code) || !entry.label?.trim() || image.protocol !== 'https:' || image.hostname !== 'megadie.s3.eu-central-1.amazonaws.com' || image.username || image.password) throw Error('Entry outside reviewed scope');
      const matches = products.filter(row => String(row.category) === String(entry.category) && row.catalogCode === entry.code);
      if (!matches.some(row => normalize(row.color) === normalize(entry.label)) || !matches.some(row => row.images?.includes(entry.imageUrl))) throw Error('Product mapping changed: '+entry.code);
    }
    const draft = catalog.isActive === false && entries.every(row => row.isActive === false);
    const published = catalog.isActive === true && entries.every(row => row.isActive === true);
    if (!draft && !published) throw Error('Mixed publication state; reconcile before publishing');
    return {catalogs, entries, categories, products, state:published ? 'published' : 'draft'};
  };
  const before = await inspect();
  const sha = fingerprint(before);
  Object.assign(report,{sha,state:before.state,catalogsToActivate:before.state === 'draft' ? 1 : 0,entriesToActivate:before.state === 'draft' ? 392 : 0});
  await fs.writeFile(path.join(output,'before.json'),JSON.stringify(before,null,2)+'\n');
  if (apply && expectedSha !== sha) throw Error('State differs from preview SHA256; rerun preview');
  if (apply && before.state === 'draft') {
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await inspect(session);
        if (fingerprint(current) !== sha || current.state !== 'draft') throw Error('Catalog or source metadata changed after preview');
        const now = new Date();
        const entryResult = await db.collection('catalogentries').updateMany({
          _id:{$in:before.entries.map(row => row._id)}, catalog:before.catalogs[0]._id, isActive:false,
        },{$set:{isActive:true,updatedAt:now}},{session});
        if (entryResult.matchedCount !== 392 || entryResult.modifiedCount !== 392) throw Error('Entry activation count mismatch');
        const catalogResult = await db.collection('catalogs').updateOne({
          _id:before.catalogs[0]._id, productType:'Ribbon', isActive:false,
        },{$set:{isActive:true,updatedAt:now}},{session});
        if (catalogResult.matchedCount !== 1 || catalogResult.modifiedCount !== 1) throw Error('Catalog activation count mismatch');
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
      report.committed = true;
      await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    } finally {await session.endSession();}
  }
  const after = apply ? await inspect() : before;
  if (apply && (after.state !== 'published' || fingerprint(content(after.catalogs)) !== fingerprint(content(before.catalogs)) || fingerprint(content(after.entries)) !== fingerprint(content(before.entries)))) throw Error('Post-publication verification failed');
  if (writes.some(write => write.command !== 'update' || !['catalogs','catalogentries'].includes(write.collection))) throw Error('Unexpected database write scope');
  if (!apply && writes.length) throw Error('Preview unexpectedly wrote to the database');
  Object.assign(report,{success:true,state:after.state,verifiedEntries:after.entries.length,activeEntries:after.entries.filter(row => row.isActive).length,writes});
  await fs.writeFile(path.join(output,'after.json'),JSON.stringify({catalogs:after.catalogs,entries:after.entries},null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
} catch (error) {
  report.error = error.message;
  process.exitCode = 1;
  console.error(error.message);
} finally {
  await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
  await mongoose.disconnect();
}
