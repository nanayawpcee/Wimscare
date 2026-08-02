/* Rotates Vercel Blob objects that were uploaded with access:'public' — every
   claim document, contribution receipt, avatar, brand logo and, most seriously,
   every full-database backup written before storage.js switched to private.
   Those objects are readable by URL alone, with no authentication.

   For each object it re-uploads the bytes to the same pathname as a private
   object and rewrites the database references from the public URL to the
   opaque storage key.

   Reachability is tested by fetching the object's public URL unauthenticated:
   a 200 means it is genuinely exposed and gets rotated; a 401/403 means it is
   already private and is skipped. That makes the script idempotent and safe to
   re-run.

   Dry run (default):  node scripts/rotate-public-blobs.js
   Apply:              node scripts/rotate-public-blobs.js --apply
*/
require('dotenv').config();
const mongoose = require('mongoose');
const { connectDB } = require('../config/db');
const Claim = require('../models/Claim');
const Backup = require('../models/Backup');
const Contribution = require('../models/Contribution');
const Organization = require('../models/Organization');
const User = require('../models/User');

const APPLY = process.argv.includes('--apply');
const TOKEN = process.env.BLOB_READ_WRITE_TOKEN;

function keyFromUrl(url) {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
}

// Objects still readable without credentials. Anything else is already private.
async function isPubliclyReadable(url) {
  const res = await fetch(url, { method: 'GET', headers: { range: 'bytes=0-0' } });
  return res.status === 200 || res.status === 206;
}

async function rotate(blob, stats) {
  const key = blob.pathname;
  if (!(await isPubliclyReadable(blob.url))) {
    stats.alreadyPrivate++;
    return null;
  }
  stats.exposed.push(key);
  if (!APPLY) return key;

  const { put } = require('@vercel/blob');
  const res = await fetch(blob.url);
  if (!res.ok) throw new Error(`Cannot read ${key} (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await put(key, buffer, {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: res.headers.get('content-type') || undefined,
    token: TOKEN,
  });
  stats.rotated++;
  return key;
}

// Rewrite every persisted reference from a full public URL to its storage key.
async function rewriteReferences(stats) {
  const rewrites = [
    ['Backup.filePath', async () => {
      const docs = await Backup.find({ filePath: /^https?:\/\// });
      for (const d of docs) {
        stats.refs.push(`Backup ${d._id} → ${keyFromUrl(d.filePath)}`);
        if (APPLY) { d.filePath = keyFromUrl(d.filePath); await d.save(); }
      }
    }],
    ['Contribution.receiptPath', async () => {
      const docs = await Contribution.find({ receiptPath: /^https?:\/\// });
      for (const d of docs) {
        stats.refs.push(`Contribution ${d._id} → ${keyFromUrl(d.receiptPath)}`);
        if (APPLY) { d.receiptPath = keyFromUrl(d.receiptPath); await d.save(); }
      }
    }],
    ['User.avatarPath', async () => {
      const docs = await User.find({ avatarPath: /^https?:\/\// });
      for (const d of docs) {
        stats.refs.push(`User ${d._id} → ${keyFromUrl(d.avatarPath)}`);
        if (APPLY) { d.avatarPath = keyFromUrl(d.avatarPath); await d.save(); }
      }
    }],
    ['Organization.facility.logoPath', async () => {
      const docs = await Organization.find({ 'facility.logoPath': /^https?:\/\// });
      for (const d of docs) {
        stats.refs.push(`Organization ${d._id} → ${keyFromUrl(d.facility.logoPath)}`);
        if (APPLY) { d.set('facility.logoPath', keyFromUrl(d.facility.logoPath)); await d.save(); }
      }
    }],
    ['Claim.documents[].path', async () => {
      const docs = await Claim.find({ 'documents.path': /^https?:\/\// });
      for (const claim of docs) {
        for (const doc of claim.documents) {
          if (!/^https?:\/\//.test(doc.path || '')) continue;
          stats.refs.push(`Claim ${claim._id} doc ${doc._id} → ${keyFromUrl(doc.path)}`);
          if (APPLY) doc.path = keyFromUrl(doc.path);
        }
        if (APPLY) await claim.save();
      }
    }],
  ];
  for (const [label, run] of rewrites) {
    try {
      await run();
    } catch (err) {
      console.error(`  ! ${label}: ${err.message}`);
    }
  }
}

async function main() {
  if (!TOKEN) {
    console.error('BLOB_READ_WRITE_TOKEN is not set — nothing is stored in Vercel Blob for this environment.');
    process.exit(1);
  }
  const { list } = require('@vercel/blob');
  await connectDB();

  const stats = { total: 0, alreadyPrivate: 0, rotated: 0, exposed: [], refs: [] };
  let cursor;
  do {
    const page = await list({ token: TOKEN, cursor, limit: 1000 });
    for (const blob of page.blobs) {
      stats.total++;
      try {
        await rotate(blob, stats);
      } catch (err) {
        console.error(`  ! ${blob.pathname}: ${err.message}`);
      }
    }
    cursor = page.hasMore ? page.cursor : null;
  } while (cursor);

  await rewriteReferences(stats);

  console.log(`\n${APPLY ? 'APPLIED' : 'DRY RUN — nothing changed'}`);
  console.log(`  objects in store:      ${stats.total}`);
  console.log(`  already private:       ${stats.alreadyPrivate}`);
  console.log(`  publicly readable:     ${stats.exposed.length}`);
  console.log(`  rotated to private:    ${stats.rotated}`);
  console.log(`  references to rewrite: ${stats.refs.length}`);

  const backups = stats.exposed.filter((k) => k.includes('/backups/'));
  if (backups.length) {
    console.log(`\n  ${backups.length} of the exposed objects are DATABASE BACKUPS:`);
    backups.forEach((k) => console.log(`    ${k}`));
  }
  if (stats.exposed.length && !APPLY) {
    console.log('\n  Re-run with --apply to rotate them.');
  }

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
