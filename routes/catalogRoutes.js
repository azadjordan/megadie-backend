import express from 'express';
import {protect, requireApproved} from '../middleware/authMiddleware.js';
import {getCatalog, getCatalogEntries, getCatalogEntry, getCatalogAvailability} from '../controllers/catalogController.js';

const router = express.Router();
router.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
router.use(protect, requireApproved);
router.get('/', getCatalog);
router.get('/:catalogId/entries', getCatalogEntries);
router.get('/:catalogId/entries/:entryId', getCatalogEntry);
router.post('/:catalogId/availability', getCatalogAvailability);
export default router;
